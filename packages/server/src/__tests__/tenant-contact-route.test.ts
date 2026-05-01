/**
 * Day 2 PR A: PATCH /tenant/contact 单测。
 * 验证：
 *  - 非 owner/admin → 403
 *  - 缺 contactName → 400
 *  - owner 正常更新返 OK + lastUpdatedAt 注入
 *  - tenantId scoping（update where tenants.id = caller's tenantId）
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

const lastWhereArg: { kind?: string; b?: unknown }[] = [];
const lastSetArg: { contactMeta?: unknown }[] = [];
let updateResult: Array<{ id: string; contactMeta: unknown }> = [];
let selectResult: Array<{ id: string; contactMeta: unknown }> = [];

vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResult) }),
      }),
    })),
    update: vi.fn(() => ({
      set: (s: { contactMeta?: unknown }) => {
        lastSetArg.push(s);
        return {
          where: (cond: any) => {
            lastWhereArg.push(cond);
            return { returning: () => Promise.resolve(updateResult) };
          },
        };
      },
    })),
  },
}));
vi.mock("../models/schema.js", () => ({
  tenants: { id: "id_col", contactMeta: "cm_col" },
  users: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ kind: "eq", a, b }),
}));

const { tenantRoutes } = await import("../routes/tenant.js");

async function buildApp(role = "owner", tenantId = "t-1"): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.decorateRequest("user", null as any);
  app.addHook("onRequest", async (req) => {
    (req as any).tenantId = tenantId;
    (req as any).user = { userId: "u-1", tenantId, role };
  });
  await app.register(tenantRoutes, { prefix: "/" });
  return app;
}

describe("PATCH /tenant/contact — Day 2 PR A", () => {
  beforeEach(() => {
    lastWhereArg.length = 0;
    lastSetArg.length = 0;
    updateResult = [{ id: "t-1", contactMeta: { contactName: "X" } }];
    selectResult = [];
  });

  it("returns 403 for non-admin role", async () => {
    const app = await buildApp("member");
    const res = await app.inject({
      method: "PATCH",
      url: "/contact",
      payload: { contactMeta: { contactName: "Test" } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns 400 when contactName missing", async () => {
    const app = await buildApp("owner");
    const res = await app.inject({
      method: "PATCH",
      url: "/contact",
      payload: { contactMeta: { wechatId: "x" } }, // 缺 contactName
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("owner updates contactMeta + injects lastUpdatedAt", async () => {
    const app = await buildApp("owner", "tenant-A");
    const res = await app.inject({
      method: "PATCH",
      url: "/contact",
      payload: {
        contactMeta: {
          contactName: "BossMate 期刊小助手",
          wechatId: "bossmate_journal",
          workingHours: "工作日 9:00-18:00",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: "OK" });
    // lastUpdatedAt 由路由注入（spec 要求）
    const cm = lastSetArg[0]?.contactMeta as Record<string, string>;
    expect(cm.contactName).toBe("BossMate 期刊小助手");
    expect(cm.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // tenantId scoping
    expect(lastWhereArg[0]).toMatchObject({ kind: "eq", b: "tenant-A" });
  });

  it("rejects invalid email format", async () => {
    const app = await buildApp("owner");
    const res = await app.inject({
      method: "PATCH",
      url: "/contact",
      payload: { contactMeta: { contactName: "X", email: "not-an-email" } },
    });
    expect(res.statusCode).toBe(400);
  });
});
