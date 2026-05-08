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

describe("PR 2: 6 卡片 stats", () => {
  it("总数 + 4 confidence 分级 + AI 编造 + 从未验证 共 6 个 SQL", async () => {
    const counts = [46, 0, 0, 0, 0, 46]; // total / high / mid / low / ai / never
    for (const c of counts) {
      whereMock.mockReturnValueOnce(Promise.resolve([{ c }]) as never);
    }
    const app = await buildApp("owner");
    const res = await app.inject({ method: "GET", url: "/api/admin/journals/audit/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      total: 46,
      highConfidence: 0,
      midConfidence: 0,
      lowConfidence: 0,
      aiFabricated: 0,
      neverVerified: 46,
    });
    expect(selectMock).toHaveBeenCalledTimes(6);
    await app.close();
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

  it("默认 page=1 pageSize=100 + confidence ASC NULLS FIRST 排序", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({ method: "GET", url: "/api/admin/journals/audit" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.page).toBe(1);
    expect(res.json().data.pageSize).toBe(100);
    expect(res.json().data.items).toHaveLength(1);
    // 验证 orderBy 调用（spec：confidence ASC NULLS FIRST）
    expect(orderByMock).toHaveBeenCalled();
    await app.close();
  });

  it("dataSources=ai_fabricated,legacy_unknown filter 解析（多选）", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/journals/audit?dataSources=ai_fabricated,legacy_unknown",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("verified=never filter（last_verified_at IS NULL）", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/journals/audit?verified=never",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("q=Lancet ilike 搜索", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/journals/audit?q=Lancet",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("confidenceMin=80 + confidenceMax=95 范围", async () => {
    const app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/journals/audit?confidenceMin=80&confidenceMax=95",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
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
    expect(src).toMatch(/PR 3 enricher 接入后实现/);
    expect(src).toMatch(/disabled/); // 按钮 disabled 直到 PR 3
  });
});
