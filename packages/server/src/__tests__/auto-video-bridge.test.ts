/** Track A.2：bridge 单测。fire-and-forget + dedup + 错误吞掉。 */
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
vi.mock("../config/logger.js", () => ({
  logger: { info: infoSpy, warn: warnSpy, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {} }));

const generateForJournalMock = vi.fn();
vi.mock("../services/skills/video-skill.js", () => ({
  VideoSkill: vi.fn().mockImplementation(() => ({ generateForJournal: generateForJournalMock })),
}));

const { triggerVideoFromArticle } = await import("../services/skills/auto-video-bridge.js");

function makeFakeDb(opts: { dedupHits?: number; insertReturn?: { id: string } }) {
  const dedupRows = Array.from({ length: opts.dedupHits ?? 0 }, (_, i) => ({ id: `dup-${i}` }));
  const inserted = opts.insertReturn ?? { id: "new-video-id" };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => dedupRows) })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => [inserted]) })),
    })),
  } as any;
}

const baseOpts = {
  provider: { name: "fake", chat: vi.fn() } as any,
  journalId: "j-1", tenantId: "t-1", userId: "u-1",
  articleContentId: "art-1", conversationId: "conv-1",
};

beforeEach(() => {
  warnSpy.mockClear();
  infoSpy.mockClear();
  generateForJournalMock.mockReset();
});

describe("triggerVideoFromArticle", () => {
  it("happy: VideoSkill 1 次 + insert 1 次 + 打 success log", async () => {
    generateForJournalMock.mockResolvedValue({
      artifact: { type: "video_script", title: "T", body: "B", metadata: { duration: 22 } },
    });
    const fakeDb = makeFakeDb({});
    await triggerVideoFromArticle({ ...baseOpts, db: fakeDb });
    expect(generateForJournalMock).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls.some((c) => /video\.auto\.success/.test(JSON.stringify(c)))).toBe(true);
  });

  it("VideoSkill 抛错 → 函数不抛 + warn 打 video.auto.failed", async () => {
    generateForJournalMock.mockRejectedValue(new Error("LLM down"));
    const fakeDb = makeFakeDb({});
    await expect(triggerVideoFromArticle({ ...baseOpts, db: fakeDb })).resolves.toBeUndefined();
    expect(fakeDb.insert).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => /video\.auto\.failed/.test(JSON.stringify(c)))).toBe(true);
  });

  it("dedup：已有 sourceArticleId 命中 → 跳过 + 不调 VideoSkill 不 insert", async () => {
    const fakeDb = makeFakeDb({ dedupHits: 1 });
    await triggerVideoFromArticle({ ...baseOpts, db: fakeDb });
    expect(generateForJournalMock).not.toHaveBeenCalled();
    expect(fakeDb.insert).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.some((c) => /video\.auto\.dedup/.test(JSON.stringify(c)))).toBe(true);
  });

});
