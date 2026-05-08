/**
 * P0-A2 integration tests：transitionStatus + transitionToStatus 全链路。
 *
 * 4 必含场景（user 强约束）：
 *  1. 完整 lifecycle：draft → generating → generated → published
 *  2. 失败重试：generating → failed → generating → generated
 *  3. 并发乐观锁：两个 transition 同源仅一个成功
 *  4. 卡死场景：generating 状态从 server restart 恢复后还是 generating
 *     （watchdog 自动 → failed 留 P0-B 实现，本测试验证手动 transition 可恢复）
 *  5. error_message 截断 500 字符
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

// ============ Stateful mock store ============
// 模拟单 article 的 DB 行，支持 SELECT 返回当前状态 + UPDATE optimistic lock
type Row = { id: string; status: string; statusUpdatedAt: Date | null; errorMessage: string | null };
let store: Record<string, Row> = {};

// db.select().from().where().limit() → 返回 [{ status: store[id].status }]
const limitMock = vi.fn();
const selectChain = {
  from: () => ({
    where: (_cond: unknown) => ({
      limit: limitMock,
    }),
  }),
};

// db.update().set().where().returning() → 检查 store[id].status === fromStatus，匹配则改并返回 [{id}]
const returningMock = vi.fn();
const updateWhereMock = vi.fn(() => ({ returning: returningMock }));
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateChain = vi.fn(() => ({ set: updateSetMock }));

// 也支持 update().set().where()（无 returning，用于 transitionToStatus 的 idempotent touch）
// drizzle 在没 .returning 时是 thenable Promise — 用 then() 模拟
const updateNoReturningMock = vi.fn(() => Promise.resolve());

vi.mock("../models/db.js", () => ({
  db: {
    select: () => selectChain,
    update: updateChain,
  },
}));

const { transitionStatus, transitionToStatus, MAX_ERROR_MESSAGE_LENGTH, InvalidTransitionError } =
  await import("../services/articles/state-machine.js");

beforeEach(() => {
  store = {};
  limitMock.mockReset();
  returningMock.mockReset();
  updateWhereMock.mockClear();
  updateSetMock.mockClear();
  updateChain.mockClear();
  updateNoReturningMock.mockClear();

  // 默认 returning：检查 set 的 status 是否跟 store 的 fromStatus 匹配
  // 简化：测试用例自己控制 returningMock 返回值（[{id}] = OK，[] = race）
});

// 辅助：声明 store 当前状态
function seed(id: string, status: string, errorMessage: string | null = null) {
  store[id] = { id, status, statusUpdatedAt: new Date(), errorMessage };
  limitMock.mockResolvedValue([{ status }]);
}

// 辅助：模拟 UPDATE 命中（fromStatus 匹配）→ 更新 store 并返回 [{id}]
function expectUpdateHit(id: string, newStatus: string, errorMessage: string | null = null) {
  returningMock.mockImplementationOnce(async () => {
    store[id] = { id, status: newStatus, statusUpdatedAt: new Date(), errorMessage };
    return [{ id }];
  });
}

// 辅助：模拟 UPDATE 落空（race）→ 返回 []
function expectUpdateMiss() {
  returningMock.mockResolvedValueOnce([]);
}

describe("P0-A2 integration: 1. 完整 lifecycle", () => {
  it("draft → generating → generated → published 全链路 transitionStatus 成功", async () => {
    const id = "art-lifecycle";
    seed(id, "draft");

    expectUpdateHit(id, "generating");
    await transitionStatus(id, "draft", "generating");
    expect(store[id].status).toBe("generating");

    expectUpdateHit(id, "generated");
    await transitionStatus(id, "generating", "generated");
    expect(store[id].status).toBe("generated");

    expectUpdateHit(id, "published");
    await transitionStatus(id, "generated", "published");
    expect(store[id].status).toBe("published");

    // 4 次 set 全检查：errorMessage 始终为 null（happy path）
    const setCalls = (updateSetMock.mock.calls as unknown as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    expect(setCalls.every((s) => s.errorMessage === null)).toBe(true);
  });
});

describe("P0-A2 integration: 2. 失败重试", () => {
  it("generating → failed → generating → generated；error 写入 failed 后清空", async () => {
    const id = "art-retry";
    seed(id, "draft");

    expectUpdateHit(id, "generating");
    await transitionStatus(id, "draft", "generating");

    expectUpdateHit(id, "failed", "DeepSeek 503");
    await transitionStatus(id, "generating", "failed", { errorMessage: "DeepSeek 503" });
    expect(store[id].errorMessage).toBe("DeepSeek 503");

    // 重试：failed → generating（应清空 error_message）
    expectUpdateHit(id, "generating");
    await transitionStatus(id, "failed", "generating");
    const setCalls = (updateSetMock.mock.calls as unknown as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const lastSet = setCalls[setCalls.length - 1];
    expect(lastSet.errorMessage).toBe(null); // 重试时清空

    expectUpdateHit(id, "generated");
    await transitionStatus(id, "generating", "generated");
    expect(store[id].status).toBe("generated");
  });
});

describe("P0-A2 integration: 3. 并发乐观锁", () => {
  it("两个 transition 同源（generating → generated），仅一个成功", async () => {
    const id = "art-race";
    seed(id, "generating");

    expectUpdateHit(id, "generated"); // 先到的赢
    expectUpdateMiss(); // 后到的 race miss

    // 并发 fire 两次（实际是顺序，但 mock 已设两次返回值模拟 DB 端 atomic）
    const winner = transitionStatus(id, "generating", "generated");
    const loser = transitionStatus(id, "generating", "generated");

    await expect(winner).resolves.toBeUndefined();
    await expect(loser).rejects.toMatchObject({ reason: "race", code: "INVALID_TRANSITION" });
  });

  it("两个 transition 不同 toStatus（generating → generated vs generating → failed），仅一个成功", async () => {
    const id = "art-race-2";
    seed(id, "generating");

    expectUpdateHit(id, "generated");
    expectUpdateMiss();

    await transitionStatus(id, "generating", "generated");
    await expect(
      transitionStatus(id, "generating", "failed", { errorMessage: "race err" }),
    ).rejects.toMatchObject({ reason: "race" });
  });
});

describe("P0-A2 integration: 4. 卡死场景（generating restart 恢复）", () => {
  it("server restart 后 SELECT 仍 generating，可手动 transition → failed（watchdog 入口）", async () => {
    const id = "art-stuck";
    seed(id, "generating"); // restart 后 DB 仍是 generating

    expectUpdateHit(id, "failed", "watchdog: 10min timeout");
    // transitionToStatus 先 SELECT 再 transit
    await transitionToStatus(id, "failed", { errorMessage: "watchdog: 10min timeout" });

    expect(store[id].status).toBe("failed");
    expect(store[id].errorMessage).toBe("watchdog: 10min timeout");
  });

  it("transitionToStatus idempotent self-touch：current === target 时只刷 statusUpdatedAt", async () => {
    const id = "art-touch";
    seed(id, "generated");

    // current === to → 走 idempotent path（仅 update 不 returning）
    // mock update().set().where() 不调 returningMock
    let touchedSet: Record<string, unknown> | null = null;
    (updateSetMock as unknown as { mockImplementationOnce: (fn: (v: unknown) => unknown) => void })
      .mockImplementationOnce((v: unknown) => {
        touchedSet = v as Record<string, unknown>;
        return { where: () => Promise.resolve() };
      });

    await transitionToStatus(id, "generated");
    expect(touchedSet).not.toBeNull();
    expect(touchedSet!.statusUpdatedAt).toBeInstanceOf(Date);
    expect(touchedSet!.status).toBeUndefined(); // 自转不改 status，只 touch 时间
  });

  it("transitionToStatus id 不存在 → InvalidTransitionError(not_found)", async () => {
    limitMock.mockResolvedValueOnce([]);
    await expect(transitionToStatus("nonexistent", "generated")).rejects.toMatchObject({
      reason: "not_found",
    });
  });
});

describe("P0-A2 integration: 5. error_message 截断 500 字符", () => {
  it(`MAX_ERROR_MESSAGE_LENGTH = ${500} 常量正确`, () => {
    expect(MAX_ERROR_MESSAGE_LENGTH).toBe(500);
  });

  it("超长 error 截断到 500", async () => {
    const id = "art-trunc";
    seed(id, "generating");
    const longError = "x".repeat(2000); // 2000 字
    expectUpdateHit(id, "failed");
    await transitionStatus(id, "generating", "failed", { errorMessage: longError });

    const setCalls = (updateSetMock.mock.calls as unknown as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const lastSet = setCalls[setCalls.length - 1];
    expect((lastSet.errorMessage as string).length).toBe(500);
  });

  it("短 error 不截断", async () => {
    const id = "art-short";
    seed(id, "generating");
    expectUpdateHit(id, "failed");
    await transitionStatus(id, "generating", "failed", { errorMessage: "短错误" });

    const setCalls = (updateSetMock.mock.calls as unknown as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const lastSet = setCalls[setCalls.length - 1];
    expect(lastSet.errorMessage).toBe("短错误");
  });

  it("非 failed 转移传 error 也被忽略（清空）", async () => {
    const id = "art-noerr";
    seed(id, "draft");
    expectUpdateHit(id, "generating");
    await transitionStatus(id, "draft", "generating", { errorMessage: "should-be-cleared" });

    const setCalls = (updateSetMock.mock.calls as unknown as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const lastSet = setCalls[setCalls.length - 1];
    expect(lastSet.errorMessage).toBe(null);
  });
});

describe("P0-A2 integration: InvalidTransitionError 类型", () => {
  it("disallowed 不调 DB", async () => {
    await expect(transitionStatus("art-x", "draft", "published")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(updateChain).not.toHaveBeenCalled();
  });
});
