/**
 * task #21 / T4-2-3: GET /content/:id/edits route 单测。
 * 验证 tenantId 双过滤（contents + boss_edits）+ 404 + order desc。
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

const lastWhereArgs: unknown[] = [];
let contentLookupResult: Array<{ id: string }> = [];
let editsResult: Array<Record<string, unknown>> = [];

vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (cond: unknown) => {
          lastWhereArgs.push(cond);
          const isContents = lastWhereArgs.length === 1;
          const promise = Promise.resolve(isContents ? contentLookupResult : editsResult);
          return { limit: () => promise, orderBy: () => ({ limit: () => promise }) };
        },
      }),
    })),
  },
}));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id_col", tenantId: "tenant_col" },
  bossEdits: { contentId: "content_id_col", tenantId: "tenant_id_col", createdAt: "created_at_col" },
  productionRecords: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ kind: "eq", a, b }),
  and: (...xs: unknown[]) => ({ kind: "and", xs }),
  // PR #131: or 改捕获 xs（contents WHERE 现含 OR(user, SYSTEM) READABLE_TENANT_FILTER）
  or: (...xs: unknown[]) => ({ kind: "or", xs }),
  desc: (x: unknown) => ({ kind: "desc", x }),
  sql: () => ({}), count: () => ({}), isNull: () => ({}), inArray: () => ({}),
}));

const { contentRoutes } = await import("../routes/content.js");

async function buildApp(tenantId = "t-1"): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req) => { (req as any).tenantId = tenantId; });
  await app.register(contentRoutes, { prefix: "/" });
  return app;
}

describe("GET /content/:id/edits — task #21", () => {
  beforeEach(() => {
    lastWhereArgs.length = 0;
    contentLookupResult = [];
    editsResult = [];
  });

  it("returns 404 when content not in caller's tenant", async () => {
    const app = await buildApp("t-1");
    const res = await app.inject({ method: "GET", url: "/c-123/edits" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns edits list (server-side desc order preserved)", async () => {
    contentLookupResult = [{ id: "c-1" }];
    editsResult = [
      { id: "e-2", action: "rewrite_section", createdAt: "2026-05-01T10:00:00Z" },
      { id: "e-1", action: "select_variant", createdAt: "2026-04-30T10:00:00Z" },
    ];
    const app = await buildApp("t-1");
    const res = await app.inject({ method: "GET", url: "/c-1/edits" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { code: string; data: { edits: Array<{ id: string }>; total: number } };
    expect(body).toMatchObject({ code: "OK", data: { total: 2 } });
    expect(body.data.edits.map((e) => e.id)).toEqual(["e-2", "e-1"]);
  });

  it("applies tenantId guard on BOTH contents and bossEdits queries (越权防御)", async () => {
    contentLookupResult = [{ id: "c-1" }];
    const app = await buildApp("tenant-A");
    await app.inject({ method: "GET", url: "/c-1/edits" });
    expect(lastWhereArgs).toHaveLength(2);
    // PR #131: contents WHERE 现含嵌套 or(eq(tenant=user), eq(tenant=SYSTEM))；递归找
    const hasTenantPredicate = (cond: any): boolean => {
      if (cond?.kind === "eq" && cond?.b === "tenant-A") return true;
      return (cond?.xs ?? []).some((c: any) => hasTenantPredicate(c));
    };
    expect(hasTenantPredicate(lastWhereArgs[0])).toBe(true); // contents 查 - 含 OR(user, SYSTEM)
    expect(hasTenantPredicate(lastWhereArgs[1])).toBe(true); // bossEdits 查 - 仍 strict eq(user)
  });
});
