/**
 * PR: routes/articles.ts 跨 tenant — system 推荐文章可被任意 tenant 用户触发视频生成。
 * 对称修 generate-video (PR Q.0) + generate-dvh-video (PR #140) 两个 route，
 * 与 publishToAccounts (PR #143) 同思路。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../config/system-recommendation.js", () => ({
  SYSTEM_RECOMMENDATION_TENANT_ID: "00000000-0000-0000-0000-000000000001",
}));

let contentLookupResult: Array<Record<string, unknown>> = [];
vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(contentLookupResult) }) }),
    })),
  },
}));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id", tenantId: "tenant_id" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...xs: unknown[]) => ({ and: xs }),
  or: (...xs: unknown[]) => ({ or: xs }),
}));

const triggerVideoMock = vi.fn();
vi.mock("../services/skills/auto-video-bridge.js", () => ({ triggerVideoFromArticle: triggerVideoMock }));
const triggerDvhMock = vi.fn();
vi.mock("../services/digital-human/index.js", () => ({
  triggerDvhFromArticle: triggerDvhMock,
  TEMPLATE_AVATAR_VOICE_MAP: {
    A_academic: { avatarCode: "CH_2d_h3UlWl4iAGZZcTqY" },
    B_marketing: { avatarCode: "CH_2d_8llEIn0PmNlTWpWs" },
    C_popular: { avatarCode: "CH_2d_UY8seLTndqU3gSXD" },
    E_industry: { avatarCode: "CH_2d_alIxNPvTg62qntxE" },
  },
  isRealMode: () => false,
}));
vi.mock("../services/ai/provider-factory.js", () => ({
  getProvider: vi.fn(() => ({ name: "fake-provider" })),
}));

const { articlesRoutes } = await import("../routes/articles.js");

const SYSTEM_TENANT = "00000000-0000-0000-0000-000000000001";
const HANXIAO_TENANT = "4c03a3d0-cad4-4286-b14d-d6b12b6422bd";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { tenantId: string }).tenantId = HANXIAO_TENANT;
    (req as unknown as { user: { userId: string } }).user = { userId: "u-hanxiao" };
  });
  await app.register(articlesRoutes, { prefix: "/" });
  return app;
}

beforeEach(() => {
  contentLookupResult = [];
  triggerVideoMock.mockReset();
  triggerDvhMock.mockReset();
});

describe("articles.ts 跨 tenant — system 推荐文章可触发视频生成", () => {
  it("generate-dvh-video: system tenant 文章 + 韩宵 → 不再 404", async () => {
    contentLookupResult = [
      { id: "art-sys", type: "article", tenantId: SYSTEM_TENANT, metadata: { templateId: "B_marketing", journalId: "j-1" }, conversationId: null },
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/art-sys/generate-dvh-video", payload: { templateId: "B_marketing" },
    });
    expect(res.statusCode).toBe(200);
    expect(triggerDvhMock).toHaveBeenCalledTimes(1);
    expect(triggerDvhMock.mock.calls[0]?.[0]).toMatchObject({ templateId: "B_marketing", tenantId: HANXIAO_TENANT });
  });

  it("generate-dvh-video: 自己 tenant 文章 → 仍正常（回归）", async () => {
    contentLookupResult = [
      { id: "art-own", type: "article", tenantId: HANXIAO_TENANT, metadata: { templateId: "A_academic" }, conversationId: null },
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/art-own/generate-dvh-video", payload: { templateId: "A_academic" },
    });
    expect(res.statusCode).toBe(200);
    expect(triggerDvhMock).toHaveBeenCalledTimes(1);
  });

  it("generate-video: system tenant 文章 + 韩宵 → 不再 404 (PR Q.0 对称修)", async () => {
    contentLookupResult = [
      { id: "art-sys-v", type: "article", tenantId: SYSTEM_TENANT, metadata: { journalId: "j-2" }, conversationId: null },
    ];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/art-sys-v/generate-video" });
    expect(res.statusCode).toBe(200);
    expect(triggerVideoMock).toHaveBeenCalledTimes(1);
    expect(triggerVideoMock.mock.calls[0]?.[0]).toMatchObject({ tenantId: HANXIAO_TENANT, journalId: "j-2" });
  });

  it("generate-video: 自己 tenant 文章 → 仍正常（回归）", async () => {
    contentLookupResult = [
      { id: "art-own-v", type: "article", tenantId: HANXIAO_TENANT, metadata: { journalId: "j-3" }, conversationId: null },
    ];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/art-own-v/generate-video" });
    expect(res.statusCode).toBe(200);
    expect(triggerVideoMock).toHaveBeenCalledTimes(1);
  });
});
