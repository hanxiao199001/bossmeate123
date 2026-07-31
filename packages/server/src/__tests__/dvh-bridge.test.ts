/** PR #137 DVH bridge 单测. mock 模式 happy + dedup + real 失败 fallback. 仿 auto-video-bridge.test.ts */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test",
  },
}));
const warnSpy = vi.fn();
const errorSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock("../config/logger.js", () => ({
  logger: { info: infoSpy, warn: warnSpy, error: errorSpy, debug: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {} }));

const isRealModeMock = vi.fn();
vi.mock("../services/digital-human/client.js", () => ({
  isRealMode: isRealModeMock,
  createDvhClient: vi.fn(),
  $avatar20220130: {},
}));
const submitDvhTaskMock = vi.fn();
vi.mock("../services/digital-human/submit-task.js", () => ({ submitDvhTask: submitDvhTaskMock }));
const queryDvhTaskMock = vi.fn();
vi.mock("../services/digital-human/query-task.js", () => ({ queryDvhTaskUntilDone: queryDvhTaskMock }));
// 7-06: PR-W1(commit 1c75dc5)在 submit 前加了 checkBudget 预算闸(晚于本测试)。不 mock → checkBudget 查 db(stub {})崩 → submit 前 throw。放行让流程到达 submit。
vi.mock("../services/billing/cost-ledger.js", () => ({
  checkBudget: vi.fn(async () => ({ allowed: true })),
  estimateDvhCents: vi.fn(() => 100),
  recordCost: vi.fn(async () => {}),
  DVH_CENTS_PER_SECOND: 16.5,
}));

const { triggerDvhFromArticle } = await import("../services/digital-human/article-bridge.js");

function makeFakeDb(opts: {
  dedupHits?: number;
  articleRow?: { id: string; title: string; body: string } | null;
  insertReturn?: { id: string };
}) {
  const dedupRows = Array.from({ length: opts.dedupHits ?? 0 }, (_, i) => ({ id: `dup-${i}` }));
  const articleRows = opts.articleRow ? [opts.articleRow] : [];
  const inserted = opts.insertReturn ?? { id: "new-video-id" };
  let selectCallCount = 0;
  const selectMock = vi.fn(() => {
    selectCallCount++;
    const rows = selectCallCount === 1 ? dedupRows : articleRows;
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
      })),
    };
  });
  return {
    select: selectMock,
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [inserted]) })),
    })),
  } as any;
}

const baseOpts = {
  tenantId: "t-1", userId: "u-1",
  articleContentId: "art-1", templateId: "A_academic" as const,
  conversationId: "conv-1", journalId: "j-1",
};

beforeEach(() => {
  warnSpy.mockClear();
  errorSpy.mockClear();
  infoSpy.mockClear();
  isRealModeMock.mockReset();
  submitDvhTaskMock.mockReset();
  queryDvhTaskMock.mockReset();
});

describe("triggerDvhFromArticle", () => {
  it("mock 模式: 照样落库, 但**不许报 success** — 报 placeholder(error 级)", async () => {
    isRealModeMock.mockReturnValue(false);
    const fakeDb = makeFakeDb({
      articleRow: { id: "art-1", title: "测试期刊", body: "<p>Lorem ipsum dolor sit amet</p>" },
    });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
    expect(queryDvhTaskMock).not.toHaveBeenCalled();
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
    // 7-31 断言翻转: 以前这里断言的是 dvh.bridge.success —— 而这条根本不是真渲染, 是固定占位样片。
    //   "占位片也报 success" 正是要消灭的东西(日志满屏成功, 真假只差一个没人看的 realMode 字段)。
    expect(infoSpy.mock.calls.some((c) => /dvh\.bridge\.success/.test(JSON.stringify(c)))).toBe(false);
    expect(errorSpy.mock.calls.some((c) => /dvh\.bridge\.placeholder/.test(JSON.stringify(c)))).toBe(true);
  });

  it("dedup: 已有 sourceArticleId+source=dvh 命中 → 跳过 + 不 fetch article 不 insert", async () => {
    isRealModeMock.mockReturnValue(false);
    const fakeDb = makeFakeDb({ dedupHits: 1 });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(fakeDb.insert).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.some((c) => /dvh\.bridge\.dedup/.test(JSON.stringify(c)))).toBe(true);
  });

  it("body.success=false fallback: real mode submit 抛 10010003 → fallback mock + insert realMode=false", async () => {
    isRealModeMock.mockReturnValue(true);
    const err = new Error("DVH submit failed: 10010003 无访问权限") as Error & { code?: string };
    err.code = "10010003";
    submitDvhTaskMock.mockRejectedValue(err);
    const fakeDb = makeFakeDb({
      articleRow: { id: "art-1", title: "测试期刊", body: "Lorem ipsum dolor sit amet" },
    });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(submitDvhTaskMock).toHaveBeenCalledTimes(1);
    expect(queryDvhTaskMock).not.toHaveBeenCalled();
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
    // 7-31 由 warn 升到 error: 真实模式下没提交成功却照样落库一条"视频"(占位样片),
    //   运营界面上看不出区别 —— 这是老板 7-31 实测"形象/背景/音色全不生效"的最可能形态, 必须是 error 级。
    expect(errorSpy.mock.calls.some((c) => /dvh\.bridge\.real_failed_fallback_mock/.test(JSON.stringify(c)))).toBe(true);
    // 7-31 同上翻转: 提交都没成功, 这条不配叫 success。落库照旧(占位样片有据可查), 但日志必须说实话。
    expect(infoSpy.mock.calls.some((c) => /dvh\.bridge\.success/.test(JSON.stringify(c)))).toBe(false);
    expect(errorSpy.mock.calls.some((c) => /dvh\.bridge\.placeholder/.test(JSON.stringify(c)))).toBe(true);
  });
});
