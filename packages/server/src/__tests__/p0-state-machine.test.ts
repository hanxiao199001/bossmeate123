/**
 * P0：article lifecycle state machine 单元测试。
 * 覆盖：转移合法性表 / isAllowed 纯函数 / transitionStatus DB 路径 + optimistic lock。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(48),
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    DATABASE_URL: "postgres://test/test",
  },
}));

// DB mock：用 returning() 数组长度模拟 optimistic lock 命中 / 失败
const returningMock = vi.fn();
const whereMock = vi.fn(() => ({ returning: returningMock }));
const setMock = vi.fn(() => ({ where: whereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));

vi.mock("../models/db.js", () => ({
  db: { update: updateMock },
}));

const { transitionStatus, isAllowed, ALLOWED_TRANSITIONS, ARTICLE_STATUSES, InvalidTransitionError } =
  await import("../services/articles/state-machine.js");

beforeEach(() => {
  returningMock.mockReset();
  whereMock.mockClear();
  setMock.mockClear();
  updateMock.mockClear();
});

describe("P0 state machine: ALLOWED_TRANSITIONS 表完整性", () => {
  it("6 个状态全覆盖", () => {
    expect(ARTICLE_STATUSES).toEqual([
      "draft",
      "generating",
      "failed",
      "generated",
      "published",
      "archived",
    ]);
    for (const s of ARTICLE_STATUSES) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("draft → [generating, archived]", () => {
    expect(ALLOWED_TRANSITIONS.draft).toEqual(["generating", "archived"]);
  });
  it("generating → [generated, failed]", () => {
    expect(ALLOWED_TRANSITIONS.generating).toEqual(["generated", "failed"]);
  });
  it("failed → [generating, archived]（重试 / 放弃）", () => {
    expect(ALLOWED_TRANSITIONS.failed).toEqual(["generating", "archived"]);
  });
  it("generated → [published, draft, archived]（发布 / 回退编辑 / 归档）", () => {
    expect(ALLOWED_TRANSITIONS.generated).toEqual(["published", "draft", "archived"]);
  });
  it("published → [archived]", () => {
    expect(ALLOWED_TRANSITIONS.published).toEqual(["archived"]);
  });
  it("archived → []（终态）", () => {
    expect(ALLOWED_TRANSITIONS.archived).toEqual([]);
  });
});

describe("P0 state machine: isAllowed 纯函数", () => {
  it("合法转移返 true", () => {
    expect(isAllowed("draft", "generating")).toBe(true);
    expect(isAllowed("generating", "generated")).toBe(true);
    expect(isAllowed("generating", "failed")).toBe(true);
    expect(isAllowed("failed", "generating")).toBe(true);
    expect(isAllowed("generated", "published")).toBe(true);
    expect(isAllowed("generated", "draft")).toBe(true);
    expect(isAllowed("published", "archived")).toBe(true);
  });
  it("非法转移返 false", () => {
    expect(isAllowed("draft", "published")).toBe(false); // 跳过 generating/generated
    expect(isAllowed("draft", "generated")).toBe(false);
    expect(isAllowed("published", "draft")).toBe(false); // 已发布不可回退编辑（只能归档）
    expect(isAllowed("published", "generating")).toBe(false);
    expect(isAllowed("archived", "draft")).toBe(false); // 终态
    expect(isAllowed("archived", "generating")).toBe(false);
    expect(isAllowed("generating", "published")).toBe(false); // 必须先 generated
  });
  it("同状态自转返 false", () => {
    expect(isAllowed("draft", "draft")).toBe(false);
    expect(isAllowed("generating", "generating")).toBe(false);
  });
});

describe("P0 state machine: transitionStatus DB 路径", () => {
  it("合法转移 + optimistic lock 命中 → DB UPDATE OK", async () => {
    returningMock.mockResolvedValueOnce([{ id: "art-1" }]);
    await transitionStatus("art-1", "draft", "generating");
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledTimes(1);
    const setArg = (setMock.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(setArg.status).toBe("generating");
    expect(setArg.errorMessage).toBe(null); // 非 failed，errorMessage 清空
    expect(setArg.statusUpdatedAt).toBeInstanceOf(Date);
  });

  it("进入 failed 写 errorMessage", async () => {
    returningMock.mockResolvedValueOnce([{ id: "art-2" }]);
    await transitionStatus("art-2", "generating", "failed", {
      errorMessage: "DeepSeek 503 timeout",
    });
    const setArg = (setMock.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(setArg.status).toBe("failed");
    expect(setArg.errorMessage).toBe("DeepSeek 503 timeout");
  });

  it("非 failed 转移传 errorMessage 也被清空", async () => {
    returningMock.mockResolvedValueOnce([{ id: "art-3" }]);
    await transitionStatus("art-3", "failed", "generating", {
      errorMessage: "should-be-ignored",
    });
    const setArg = (setMock.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(setArg.errorMessage).toBe(null); // failed → generating 必须清空旧错误
  });

  it("非法转移抛 InvalidTransitionError(disallowed) 不查 DB", async () => {
    await expect(transitionStatus("art-4", "draft", "published")).rejects.toThrow(
      InvalidTransitionError,
    );
    await expect(transitionStatus("art-4", "draft", "published")).rejects.toMatchObject({
      reason: "disallowed",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("optimistic lock 0 命中 → InvalidTransitionError(race)", async () => {
    returningMock.mockResolvedValueOnce([]); // race：DB 当前 status ≠ fromStatus
    await expect(transitionStatus("art-5", "draft", "generating")).rejects.toMatchObject({
      reason: "race",
      code: "INVALID_TRANSITION",
    });
  });

  it("并发 race：两次 generating → generated 仅一次成功", async () => {
    returningMock.mockResolvedValueOnce([{ id: "art-6" }]); // 第一次 OK
    returningMock.mockResolvedValueOnce([]); // 第二次 race
    await transitionStatus("art-6", "generating", "generated");
    await expect(transitionStatus("art-6", "generating", "generated")).rejects.toMatchObject({
      reason: "race",
    });
  });
});

describe("P0 state machine: 完整 lifecycle 链", () => {
  it("draft → generating → generated → published → archived 全链路 isAllowed", () => {
    const happyPath: Array<[string, string]> = [
      ["draft", "generating"],
      ["generating", "generated"],
      ["generated", "published"],
      ["published", "archived"],
    ];
    for (const [from, to] of happyPath) {
      expect(isAllowed(from as never, to as never)).toBe(true);
    }
  });

  it("失败重试链：draft → generating → failed → generating → generated", () => {
    const retryPath: Array<[string, string]> = [
      ["draft", "generating"],
      ["generating", "failed"],
      ["failed", "generating"],
      ["generating", "generated"],
    ];
    for (const [from, to] of retryPath) {
      expect(isAllowed(from as never, to as never)).toBe(true);
    }
  });

  it("回退编辑链：generated → draft → generating → generated", () => {
    const reeditPath: Array<[string, string]> = [
      ["generated", "draft"],
      ["draft", "generating"],
      ["generating", "generated"],
    ];
    for (const [from, to] of reeditPath) {
      expect(isAllowed(from as never, to as never)).toBe(true);
    }
  });
});
