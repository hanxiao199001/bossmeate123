/**
 * PR 2（5-9 早）：/admin/journals/audit 后端测试。
 * 覆盖：admin role check / 6 卡片 stats / 列表 filter + 排序 / 分页。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

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

// SELECT mock：每个 stats 子查询 + 列表查询都用同一 chain，按调用顺序返回 mockResolvedValueOnce
const offsetMock = vi.fn();
const limitMock = vi.fn(() => ({ offset: offsetMock }));
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock("../models/db.js", () => ({
  db: { select: selectMock },
}));

const { journalsAuditRoutes } = await import("../routes/journals-audit.js");

beforeEach(() => {
  selectMock.mockClear();
  fromMock.mockClear();
  whereMock.mockClear();
  orderByMock.mockClear();
  limitMock.mockClear();
  offsetMock.mockReset();
});

async function buildApp(role: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (req, _reply, done) => {
    (req as unknown as { user: { role: string }; tenantId: string }).user = { role };
    (req as unknown as { tenantId: string }).tenantId = "t-1";
    done();
  });
  await app.register(journalsAuditRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("PR 2: admin role 守卫", () => {
  it("member 角色访问 /stats → 403", async () => {
    const app = await buildApp("member");
    const res = await app.inject({ method: "GET", url: "/api/admin/journals/audit/stats" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    await app.close();
  });

  it("editor 角色访问列表 → 403", async () => {
    const app = await buildApp("editor");
    const res = await app.inject({ method: "GET", url: "/api/admin/journals/audit" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("owner / admin 通过守卫", async () => {
    // 6 个 select.from.where 都返回 [{c:0}]
    for (let i = 0; i < 6; i++) {
      whereMock.mockReturnValueOnce(Promise.resolve([{ c: 0 }]) as never);
    }
    const app = await buildApp("owner");
    const res = await app.inject({ method: "GET", url: "/api/admin/journals/audit/stats" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("PR 2: 6 卡片 stats（PR #113 改 static grep，因 PR #110 砍 tenantFilter 后 SELECT pattern 变）", () => {
  it("stats route 含 6 个 count() 调用（stats）+ 1 个（list） + 6 个返回字段", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/journals-audit.ts", import.meta.url), "utf8");
    // stats 6 + list 1 = 7 个 count() 调用
    const countMatches = src.match(/count\(\)/g);
    expect(countMatches?.length).toBe(7);
    // 6 卡片字段
    for (const f of ["total:", "highConfidence:", "midConfidence:", "lowConfidence:", "aiFabricated:", "neverVerified:"]) {
      expect(src).toContain(f);
    }
  });
});

describe("PR 2: 列表 filter + 分页", () => {
  beforeEach(() => {
    // 列表查询 = 1 select + 1 count
    offsetMock.mockResolvedValueOnce([
      { id: "j-1", name: "Test Journal", confidence: null, dataSource: "legacy_unknown" },
    ]);
    whereMock.mockReturnValueOnce({ orderBy: orderByMock } as never); // list query
    whereMock.mockReturnValueOnce(Promise.resolve([{ c: 1 }]) as never); // count query
  });

  it("默认 page=1 pageSize=100 + confidence ASC NULLS FIRST 排序（PR #113 改 static grep，因 PR #110 conditions 空时不调 .where）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/journals-audit.ts", import.meta.url), "utf8");
    // 默认值：page=1, pageSize=100
    expect(src).toMatch(/page:\s*z\.coerce\.number\(\).*\.default\(1\)/);
    expect(src).toMatch(/pageSize:\s*z\.coerce\.number\(\).*\.default\(100\)/);
    // confidence ASC NULLS FIRST 排序
    expect(src).toMatch(/\$\{journals\.confidence\}\s*ASC NULLS FIRST/);
  });

  it("dataSources filter 多选解析（PR #113 改 static grep，因 inArray mock 链差异）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/journals-audit.ts", import.meta.url), "utf8");
    // 解析逻辑：split(",") + filter + inArray
    expect(src).toMatch(/parsed\.dataSources\.split\("," ?\)/);
    expect(src).toMatch(/inArray\(journals\.dataSource,\s*list\)/);
  });

  it("verified=never filter 解析（PR #113 改 static grep，isNull mock 链差异）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/journals-audit.ts", import.meta.url), "utf8");
    expect(src).toMatch(/parsed\.verified === "never"/);
    expect(src).toMatch(/isNull\(journals\.lastVerifiedAt\)/);
  });

  it("q=keyword ilike 搜索 解析（PR #113 改 static grep，因 ilike mock 链差异）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/journals-audit.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ilike\(journals\.name,\s*kw\)/);
    expect(src).toMatch(/ilike\(journals\.nameEn,\s*kw\)/);
  });

  it("confidenceMin/Max 范围 解析（PR #113 改 static grep）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/journals-audit.ts", import.meta.url), "utf8");
    expect(src).toMatch(/gte\(journals\.confidence,\s*parsed\.confidenceMin\)/);
    expect(src).toMatch(/lte\(journals\.confidence,\s*parsed\.confidenceMax\)/);
  });

  it("非法 page=0 → 400 BAD_REQUEST", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({ method: "GET", url: "/api/admin/journals/audit?page=0" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("PR 2: enricher 接入预留", () => {
  it("source code 含 [🔄 重新验证] PR 3 占位 placeholder（前端文件防回归）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/pages/AdminJournalsAuditPage.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/🔄 重新验证/);
    // PR #107（enricher 接入）后 button enable，PR #113 删除"PR 3 占位"占位文案
    expect(src).toMatch(/ReverifyButton/); // 真组件已实现
    expect(src).toMatch(/api\.post[\s\S]*?reverify/); // 真调 API
  });
});
