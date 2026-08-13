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
  /**
   * 8-12 行为变更（第三次翻转，把前两次没做完的做完）：
   *   7-31 让占位片不再报 success（但**照样落库**）
   *   8-12 连落库也取消 —— 实测线上因此躺着 4 条「status=draft、看不出异常」的假成品。
   * 现在 REAL_MODE 未开且未显式配 DVH_MOCK_FIXTURE_BASE → 当场失败，
   * 落一条 status=failed 的记录（body=口播稿原文，供重跑），而不是一条像成品的视频。
   */
  it("mock 模式且未显式配演示素材: 不产视频, 落 failed 记录", async () => {
    isRealModeMock.mockReturnValue(false);
    const fakeDb = makeFakeDb({
      articleRow: { id: "art-1", title: "测试期刊", body: "<p>Lorem ipsum dolor sit amet</p>" },
    });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
    expect(queryDvhTaskMock).not.toHaveBeenCalled();
    // 仍然落库一行 —— 但那是失败记录, 不是"看起来像成品的视频"(见 recordDvhArticleFailure)
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls.some((c) => /dvh\.bridge\.success/.test(JSON.stringify(c)))).toBe(false);
    expect(warnSpy.mock.calls.some((c) => /dvh\.bridge\.fatal/.test(JSON.stringify(c)))).toBe(true);
  });

  it("dedup: 已有 sourceArticleId+source=dvh 命中 → 跳过 + 不 fetch article 不 insert", async () => {
    isRealModeMock.mockReturnValue(false);
    const fakeDb = makeFakeDb({ dedupHits: 1 });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(fakeDb.insert).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.some((c) => /dvh\.bridge\.dedup/.test(JSON.stringify(c)))).toBe(true);
  });

  it("real mode submit 抛 10010003 → 不退占位样片, 落 failed 记录", async () => {
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
    // 8-12: 落的这一行是 status=failed 的失败记录(body=口播稿原文, 供 deferred 重跑),
    //   不再是一条"占位样片冒充的视频"。
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.some((c) => /dvh\.bridge\.real_failed_fallback_mock/.test(JSON.stringify(c)))).toBe(true);
    expect(infoSpy.mock.calls.some((c) => /dvh\.bridge\.success/.test(JSON.stringify(c)))).toBe(false);
    expect(warnSpy.mock.calls.some((c) => /dvh\.bridge\.fatal/.test(JSON.stringify(c)))).toBe(true);
  });
});
