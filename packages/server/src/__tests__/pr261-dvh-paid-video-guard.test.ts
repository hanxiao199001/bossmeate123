/**
 * 5-29 PR #261 — DVH 付费视频防丢失 (防烧钱).
 * submit 即扣费 (0.165 元/秒). 两条原本会丢弃付费产物的路径补救:
 *   A) query 成功拿到付费 videoUrl 后, 落库失败 → 重试 + ERROR 可恢复日志, 绝不退 mock.
 *   B) submit 成功 (已扣费) 但 query 失败/超时 → 记 orphanTaskUuid 供后续 re-query 找回.
 * 仿 dvh-bridge.test.ts 的 mock 脚手架.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test",
  },
}));
const warnSpy = vi.fn();
const infoSpy = vi.fn();
const errorSpy = vi.fn();
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
const postprocessMock = vi.fn();
vi.mock("../services/digital-human/video-postprocess.js", () => ({ postprocessVideoWithSubtitle: postprocessMock }));

const { triggerDvhFromArticle } = await import("../services/digital-human/article-bridge.js");

function makeFakeDb(opts: {
  articleRow?: { id: string; title: string; body: string } | null;
  insertError?: Error;
  insertReturn?: { id: string };
}) {
  const articleRows = opts.articleRow ? [opts.articleRow] : [];
  const inserted = opts.insertReturn ?? { id: "new-video-id" };
  const captured: { values?: any } = {};
  let selectCallCount = 0;
  const selectMock = vi.fn(() => {
    selectCallCount++;
    const rows = selectCallCount === 1 ? [] : articleRows; // 第1次 dedup 查空, 第2次取 article
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
      })),
    };
  });
  const insertMock = vi.fn(() => ({
    values: vi.fn((vals: any) => {
      captured.values = vals;
      return {
        returning: vi.fn(async () => {
          if (opts.insertError) throw opts.insertError;
          return [inserted];
        }),
      };
    }),
  }));
  return { select: selectMock, insert: insertMock, _captured: captured } as any;
}

const baseOpts = {
  tenantId: "t-1", userId: "u-1",
  articleContentId: "art-1", templateId: "A_academic" as const,
  conversationId: "conv-1", journalId: "j-1",
};

beforeEach(() => {
  warnSpy.mockClear(); infoSpy.mockClear(); errorSpy.mockClear();
  isRealModeMock.mockReset(); submitDvhTaskMock.mockReset();
  queryDvhTaskMock.mockReset(); postprocessMock.mockReset();
});

describe("PR #261: 付费视频落库失败防丢", () => {
  it("A) query 成功(已付费)但 insert 抛错 → 重试 2 次 + ERROR 可恢复日志(含 videoUrl+taskUuid), 不退 mock", async () => {
    isRealModeMock.mockReturnValue(true);
    submitDvhTaskMock.mockResolvedValue({ taskUuid: "task-paid-1", submitMs: 10 });
    queryDvhTaskMock.mockResolvedValue({ videoUrl: "https://oss/paid-1.mp4", durationMs: 90000, subtitlesUrl: "https://oss/1.srt" });
    postprocessMock.mockResolvedValue({ videoUrl: "https://oss/pp-1.mp4", postprocessed: true });
    const fakeDb = makeFakeDb({
      articleRow: { id: "art-1", title: "测试期刊", body: "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do" },
      insertError: new Error("db connection lost"),
    });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(fakeDb.insert).toHaveBeenCalledTimes(2); // 重试
    const errStr = JSON.stringify(errorSpy.mock.calls);
    expect(errStr).toContain("dvh.bridge.insert_failed_paid_video_recoverable");
    expect(errStr).toContain("task-paid-1");
    expect(errStr).toContain("paid-1.mp4"); // rawVideoUrl 可恢复
  });

  it("B) submit 成功(已扣费)但 query 超时 → 记 orphanTaskUuid 到 metadata + ERROR, postprocess 不触发", async () => {
    isRealModeMock.mockReturnValue(true);
    submitDvhTaskMock.mockResolvedValue({ taskUuid: "task-orphan-9", submitMs: 10 });
    queryDvhTaskMock.mockRejectedValue(new Error("DVH query timeout 600000ms"));
    const fakeDb = makeFakeDb({
      articleRow: { id: "art-1", title: "测试期刊", body: "Lorem ipsum dolor sit amet consectetur adipiscing elit" },
    });
    await triggerDvhFromArticle({ ...baseOpts, db: fakeDb });
    expect(postprocessMock).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("dvh.bridge.paid_task_orphaned_query_failed");
    expect(fakeDb._captured.values.metadata.orphanTaskUuid).toBe("task-orphan-9");
  });
});
