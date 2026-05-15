/**
 * PR #140: POST /articles/:id/generate-dvh-video 单测。
 * 4 路径: happy / 404 article 不存在 / 400 templateId 缺失或非法 / 503 real mode env 缺.
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

let contentLookupResult: Array<Record<string, unknown>> = [];
vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(contentLookupResult) }),
      }),
    })),
  },
}));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id_col", tenantId: "tenant_col" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ kind: "eq", a, b }),
  and: (...xs: unknown[]) => ({ kind: "and", xs }),
  or: (...xs: unknown[]) => ({ kind: "or", xs }),
}));

// PR #140 关心的 mock — DVH bridge + isRealMode
const triggerDvhMock = vi.fn();
const isRealModeMock = vi.fn();
vi.mock("../services/digital-human/index.js", () => ({
  triggerDvhFromArticle: triggerDvhMock,
  TEMPLATE_AVATAR_VOICE_MAP: {
    A_academic: { avatarCode: "CH_2d_h3UlWl4iAGZZcTqY" },
    B_marketing: { avatarCode: "CH_2d_8llEIn0PmNlTWpWs" },
    C_popular: { avatarCode: "CH_2d_UY8seLTndqU3gSXD" },
    E_industry: { avatarCode: "CH_2d_alIxNPvTg62qntxE" },
  },
  isRealMode: isRealModeMock,
}));
// articles.ts import 但本 PR 不测的 mock
vi.mock("../services/skills/auto-video-bridge.js", () => ({ triggerVideoFromArticle: vi.fn() }));
vi.mock("../services/ai/provider-factory.js", () => ({ getProvider: vi.fn(() => null) }));

const { articlesRoutes } = await import("../routes/articles.js");

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { tenantId: string }).tenantId = "t-1";
    (req as unknown as { user: { userId: string } }).user = { userId: "u-1" };
  });
  await app.register(articlesRoutes, { prefix: "/" });
  return app;
}

beforeEach(() => {
  contentLookupResult = [];
  triggerDvhMock.mockReset();
  isRealModeMock.mockReset();
  isRealModeMock.mockReturnValue(false);
  delete process.env.DVH_TENANT_ID;
  delete process.env.DVH_APP_ID;
});

describe("POST /articles/:id/generate-dvh-video — PR #140", () => {
  it("happy: 真 article + templateId in body → 200 + bridge 真触发", async () => {
    contentLookupResult = [{ id: "art-1", type: "article", metadata: {}, conversationId: null }];
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/art-1/generate-dvh-video",
      payload: { templateId: "A_academic" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: "OK", data: { templateId: "A_academic", status: "triggered" } });
    expect(triggerDvhMock).toHaveBeenCalledTimes(1);
    expect(triggerDvhMock.mock.calls[0]?.[0]).toMatchObject({ articleContentId: "art-1", templateId: "A_academic" });
  });

  it("happy: templateId 从 article.metadata.templateId 读 → 200 + bridge 触发", async () => {
    contentLookupResult = [
      { id: "art-2", type: "article", metadata: { templateId: "B_marketing" }, conversationId: null },
    ];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/art-2/generate-dvh-video", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(triggerDvhMock).toHaveBeenCalledTimes(1);
    expect(triggerDvhMock.mock.calls[0]?.[0]).toMatchObject({ templateId: "B_marketing" });
  });

  it("404: article 不存在或类型不是 article → 不触发 bridge", async () => {
    contentLookupResult = [];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/not-exist/generate-dvh-video", payload: { templateId: "A_academic" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(triggerDvhMock).not.toHaveBeenCalled();
  });

  it("400: templateId 不在 4 套 mapping → 不触发 bridge", async () => {
    contentLookupResult = [{ id: "art-3", type: "article", metadata: {}, conversationId: null }];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/art-3/generate-dvh-video", payload: { templateId: "bogus-template" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "NO_TEMPLATE_ID" });
    expect(triggerDvhMock).not.toHaveBeenCalled();
  });

  it("503: real mode 且 DVH_TENANT_ID/APP_ID 缺 → 不触发 bridge", async () => {
    contentLookupResult = [{ id: "art-4", type: "article", metadata: {}, conversationId: null }];
    isRealModeMock.mockReturnValue(true);
    // DVH_TENANT_ID + DVH_APP_ID 在 beforeEach 已 delete
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/art-4/generate-dvh-video", payload: { templateId: "C_popular" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "NO_DVH" });
    expect(triggerDvhMock).not.toHaveBeenCalled();
  });
});
