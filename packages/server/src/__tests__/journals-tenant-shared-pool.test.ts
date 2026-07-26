import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * 7-25: journals 读路径的 tenant 口径回归锁。
 *
 * 病根(同一个病, 犯了四次): 线上 8743 本期刊的 `tenant_id` 是 **NULL** —— 它们是全局共享池,
 *   只有租户自建刊才带 tenant_id。而 SQL 里 `NULL = 'uuid'` 求值为 NULL(不是 true 也不是
 *   false), 所以 `eq(journals.tenantId, tenantId)` 会把**整个共享池排除在外**, 端点对任何
 *   租户都返回 0 条。
 *
 * 四处发病(前三处 7-25 修, 第四处本轮全文件扫出来):
 *   ① POST /journals/match          → 小程序选刊恒为空(已修, 见 journals-match-discipline-code)
 *   ② GET  /journals                → 期刊列表页恒为空
 *   ③ GET  /journals/meta/disciplines → 学科筛选下拉框恒为空
 *   ④ GET  /journals/:id/warning-check → 详情页能开、点"预警检查"却 404
 *
 * 统一口径: `or(isNull(tenantId), eq(tenantId, current))`, 与 GET /journals/:id (早就这么写)
 *   和 daily-cron 选刊器一致。
 *
 * **只放宽读**。写路径(seed / patch / enrich / enrich-all)必须保持严格租户隔离 —— 本文件
 *   最后一个 describe 就是防止有人"顺手把写路径也放宽了"。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_SRC = readFileSync(resolve(HERE, "../routes/journals.ts"), "utf8");

/** 取某个端点注册到下一个端点注册之间的源码 */
function endpointBody(marker: string): string {
  const start = ROUTE_SRC.indexOf(marker);
  expect(start, `端点未找到: ${marker}`).toBeGreaterThan(-1);
  const rest = ROUTE_SRC.slice(start + 1);
  const end = rest.search(/\n\s{2}app\.(get|post|patch|put|delete)\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** 共享池放行的标准写法(参数顺序两种都认) */
const SHARED_POOL_OK =
  /or\(\s*isNull\(journals\.tenantId\),\s*eq\(journals\.tenantId, tenantId\)\s*\)|or\(\s*eq\(journals\.tenantId, tenantId\),\s*isNull\(journals\.tenantId\)\s*\)/;

/** 裸的严格相等(不在 or(...) 里) —— 读路径里出现即为病 */
const BARE_STRICT_EQ = /(?<!or\(\s*isNull\(journals\.tenantId\),\s*)\beq\(journals\.tenantId, tenantId\)/;

const READ_ENDPOINTS: Array<[string, string]> = [
  ["GET /journals(列表)", 'app.get("/journals",'],
  ["GET /journals/:id(详情)", 'app.get("/journals/:id"'],
  ["GET /journals/:id/warning-check(预警检查)", 'app.get("/journals/:id/warning-check"'],
  ["GET /journals/meta/disciplines(学科下拉)", 'app.get("/journals/meta/disciplines"'],
  ["POST /journals/match(小程序选刊)", 'app.post("/journals/match"'],
];

describe("读路径: 共享池(tenant_id IS NULL)必须可见", () => {
  for (const [label, marker] of READ_ENDPOINTS) {
    it(`${label} 用 isNull OR eq, 不用严格相等`, () => {
      const body = endpointBody(marker);
      expect(body).toMatch(SHARED_POOL_OK);
    });
  }

  it("④ warning-check 与 :id 详情同口径(同一本刊不能一个能看一个 404)", () => {
    const detail = endpointBody('app.get("/journals/:id"');
    const warn = endpointBody('app.get("/journals/:id/warning-check"');
    expect(detail).toMatch(SHARED_POOL_OK);
    expect(warn).toMatch(SHARED_POOL_OK);
  });

  it("② 列表与 ③ 下拉框同口径(否则下拉里有的学科在列表里查不到)", () => {
    expect(endpointBody('app.get("/journals",')).toMatch(SHARED_POOL_OK);
    expect(endpointBody('app.get("/journals/meta/disciplines"')).toMatch(SHARED_POOL_OK);
  });

  it("全文件扫描: 读端点里不再残留裸 eq(journals.tenantId, tenantId)", () => {
    for (const [label, marker] of READ_ENDPOINTS) {
      const body = endpointBody(marker)
        // 注释里可以提旧写法(那是历史说明), 只查代码
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(BARE_STRICT_EQ.test(body), `${label} 仍有裸严格相等`).toBe(false);
    }
  });
});

/**
 * 写路径**必须**保持严格隔离。放宽读是为了让共享参考数据可见;
 * 放宽写等于让任意租户改动/触发改动全局 8743 本刊, 那是另一个量级的事故。
 */
describe("写路径: 严格租户隔离不许放宽", () => {
  it("POST /journals/seed 仍是严格相等(只能种自己的刊)", () => {
    const body = endpointBody('app.post("/journals/seed"');
    expect(body).toMatch(/eq\(journals\.tenantId, tenantId\)/);
    expect(body).not.toMatch(SHARED_POOL_OK);
  });

  it("POST /journals/:id/enrich 仍是严格相等(共享池富化走 journals:reenrich 脚本)", () => {
    const body = endpointBody('app.post("/journals/:id/enrich"');
    expect(body).toMatch(/and\(eq\(journals\.id, id\), eq\(journals\.tenantId, tenantId\)\)/);
  });

  it("POST /journals/enrich-all 仍是严格相等", () => {
    const body = endpointBody('app.post("/journals/enrich-all"');
    expect(body).toMatch(/\[eq\(journals\.tenantId, tenantId\)\]/);
  });

  it("PATCH /journals/:id 例外是**显式授权**的: owner/admin 角色闸 + 只为改重点期刊", () => {
    const body = endpointBody('app.patch("/journals/:id"');
    // 先有角色闸, 才允许碰全局刊 —— 两者缺一即为漏洞
    expect(body).toMatch(/role !== "owner" && role !== "admin"/);
    expect(body).toMatch(SHARED_POOL_OK);
  });
});

/** 纯逻辑复刻: SQL 里 NULL 等不上任何 uuid —— 这是四次犯病的共同根因 */
describe("根因复刻: NULL = uuid 恒不成立", () => {
  interface Row { id: string; tenantId: string | null }
  const strictEq = (rows: Row[], t: string) => rows.filter((r) => r.tenantId === t);
  const sharedOk = (rows: Row[], t: string) => rows.filter((r) => r.tenantId === null || r.tenantId === t);

  const POOL: Row[] = [
    { id: "shared-1", tenantId: null },   // 8743 本共享刊长这样
    { id: "shared-2", tenantId: null },
    { id: "own-1", tenantId: "t-a" },
    { id: "other-1", tenantId: "t-b" },
  ];

  it("严格相等: 共享池全丢(线上现象 = 列表/下拉/匹配全空)", () => {
    expect(strictEq(POOL, "t-a").map((r) => r.id)).toEqual(["own-1"]);
    // 一个没自建刊的新租户 → 彻底 0 条, 正是老韩看到的现象
    expect(strictEq(POOL, "t-new")).toEqual([]);
  });

  it("isNull OR eq: 共享池 + 自有刊可见, 别家自建刊仍不可见", () => {
    expect(sharedOk(POOL, "t-a").map((r) => r.id)).toEqual(["shared-1", "shared-2", "own-1"]);
    expect(sharedOk(POOL, "t-b").map((r) => r.id)).toEqual(["shared-1", "shared-2", "other-1"]);
    expect(sharedOk(POOL, "t-a").some((r) => r.id === "other-1")).toBe(false); // 跨租户不漏
  });
});
