/**
 * PR #110 hotfix（5-9 user 反馈 audit stat 全 0）：admin audit 视图全局，不按 tenant 过滤。
 *
 * Root cause：PR #105 实施时加了 `eq(journals.tenantId, request.tenantId)` 过滤，
 * 但 journals 是 PR B.12 的全局参考数据（tenant_id NULL = 共享）→ NULL ≠ UUID → 0 命中。
 *
 * Spec：user 5-9 明确"admin 视图应全局, 不该按 tenant 过滤"。
 * 本 test 锁定 audit route 不再含 tenantId filter，防回归。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR #110: audit route 砍 tenant filter（admin 全局）", () => {
  const src = readSrc("routes/journals-audit.ts");

  it("stats handler 不再含 tenantFilter = eq(journals.tenantId, ...)", () => {
    // 全文不再含 tenantFilter 变量声明
    expect(src).not.toMatch(/const\s+tenantFilter\s*=\s*eq\(journals\.tenantId/);
  });

  it("list handler conditions 数组初始化为空（不含 tenantId 强制过滤）", () => {
    // 旧：conditions = [eq(journals.tenantId, request.tenantId)]
    // 新：conditions: SQL[] = []
    expect(src).not.toMatch(/conditions\s*=\s*\[eq\(journals\.tenantId,\s*request\.tenantId\)\]/);
    expect(src).toMatch(/conditions:.*\[\];/);
  });

  it("reverify handler 不再校验 journals.tenantId 归属", () => {
    expect(src).not.toMatch(/and\(eq\(journals\.id,\s*id\),\s*eq\(journals\.tenantId,\s*request\.tenantId\)\)/);
  });

  it("含 PR #110 root cause 注释（防 refactor 误恢复 tenant filter）", () => {
    expect(src).toMatch(/PR #110.*hotfix|hotfix.*5-9|admin.*全局/);
    expect(src).toMatch(/journals.*全局.*参考|tenant_id NULL/);
  });

  it("admin role 守卫保留（仅 admin 能访问）", () => {
    // 三处 isAdmin 守卫应仍在
    expect(src.match(/if\s*\(!isAdmin\(request\.user\.role\)\)/g)?.length).toBe(3);
  });
});

describe("PR #110: SQL 行为锁定", () => {
  const src = readSrc("routes/journals-audit.ts");

  it("stats 6 个 SELECT 都不含 tenantFilter（直接查全表）", () => {
    // 数 db.select... 调用不再 .where(and(tenantFilter, ...))
    expect(src).not.toMatch(/where\(and\(tenantFilter/);
    // 但仍含 isNull(journals.lastVerifiedAt) / gte(journals.confidence) 等业务 filter
    expect(src).toMatch(/isNull\(journals\.lastVerifiedAt\)/);
    expect(src).toMatch(/gte\(journals\.confidence,\s*80\)/);
  });
});
