/**
 * Day 2 PR B: PATCH /journals/:id 单测。
 * 验证：
 *  - 非 owner/admin → 403
 *  - 未知字段（如 ifHistory jsonb） → 400 strict 拦截
 *  - 不存在 / 跨租户 → 404
 *  - owner 正常更新（白名单字段 + tenantId scoping）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    REDIS_URL: "redis://localhost:6379",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../services/task/queue.js", () => ({ journalEnrichQueue: { add: vi.fn(), getJob: vi.fn() } }));
vi.mock("../services/task/enrich-throttle.js", () => ({ shuffleFisherYates: (x: unknown[]) => x }));

const lastWhereArg: any[] = [];
const lastSetArg: any[] = [];
let updateResult: Array<Record<string, unknown>> = [];

vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]), orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }), groupBy: () => ({ orderBy: () => Promise.resolve([]) }) }),
      }),
    })),
    update: vi.fn(() => ({
      set: (s: unknown) => {
        lastSetArg.push(s);
        return {
          where: (cond: unknown) => {
            lastWhereArg.push(cond);
            return { returning: () => Promise.resolve(updateResult) };
          },
        };
      },
    })),
    insert: vi.fn(() => ({ values: () => Promise.resolve() })),
  },
}));
vi.mock("../models/schema.js", () => ({
  journals: { id: "id_col", tenantId: "tenant_col", discipline: "disc_col", impactFactor: "if_col", updatedAt: "ua_col" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ kind: "eq", a, b }),
  and: (...xs: unknown[]) => ({ kind: "and", xs }),
  or: (...xs: unknown[]) => ({ kind: "or", xs }), // journals.ts GET/:id 用 or(isNull(tenantId), eq(...))
  isNull: (a: unknown) => ({ kind: "isNull", a }),
  sql: () => ({}), gte: () => ({}), lte: () => ({}), ilike: () => ({}), desc: () => ({}), asc: () => ({}),
}));

const { journalRoutes } = await import("../routes/journals.js");

async function buildApp(role = "owner", tenantId = "t-1"): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.decorateRequest("user", null as any);
  app.addHook("onRequest", async (req) => {
    (req as any).tenantId = tenantId;
    (req as any).user = { userId: "u-1", tenantId, role };
  });
  await app.register(journalRoutes, { prefix: "/" });
  return app;
}

describe("PATCH /journals/:id — Day 2 PR B", () => {
  beforeEach(() => {
    lastWhereArg.length = 0;
    lastSetArg.length = 0;
    updateResult = [{ id: "j-1", discipline: "medicine", impactFactor: 4.5 }];
  });

  it("returns 403 for non-admin role", async () => {
    const app = await buildApp("member");
    const res = await app.inject({
      method: "PATCH",
      url: "/journals/j-1",
      payload: { discipline: "medicine" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unknown fields (jsonb 越权防御)", async () => {
    const app = await buildApp("owner");
    const res = await app.inject({
      method: "PATCH",
      url: "/journals/j-1",
      payload: { ifHistory: { foo: "bar" } }, // jsonb 字段不在白名单
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns 404 when journal not in caller's tenant", async () => {
    updateResult = [];
    const app = await buildApp("owner", "tenant-X");
    const res = await app.inject({
      method: "PATCH",
      url: "/journals/j-other",
      payload: { discipline: "medicine" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("owner updates whitelisted fields + tenantId scoping", async () => {
    const app = await buildApp("admin", "tenant-A");
    const res = await app.inject({
      method: "PATCH",
      url: "/journals/j-1",
      payload: { discipline: "medicine", impactFactor: 5.5, acceptanceRate: 0.3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: "ok" });
    // tenantId scoping: where 是 and(eq(id, j-1), eq(tenantId, tenant-A))
    const whereCond = lastWhereArg[0];
    expect(whereCond.kind).toBe("and");
    const tenantPredicate = whereCond.xs.some((c: any) => c?.kind === "eq" && c?.b === "tenant-A");
    expect(tenantPredicate).toBe(true);
    // set 仅含白名单字段（+ updatedAt）
    expect(lastSetArg[0].discipline).toBe("medicine");
    expect(lastSetArg[0].impactFactor).toBe(5.5);
    expect(lastSetArg[0].updatedAt).toBeInstanceOf(Date);
  });
});
