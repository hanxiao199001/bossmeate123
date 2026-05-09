/**
 * PR #115（5-10 hotfix）：journals user GET /:id 允许全局共享 row。
 *
 * Bug：ContentDetailPage 加载 BMC 医学（tenant_id NULL）→ GET /journals/:id
 *      → routes/journals.ts:244 严格 eq(tenantId) → NULL ≠ UUID → 404 "期刊不存在"
 *      → api.ts:106 全局 toast.error → 红色 toast
 *
 * Fix：user GET /:id 改 or(isNull(tenantId), eq(tenantId, current))，
 *      让 user 看到全局 + 自定义（PATCH/DELETE 保留严格 filter 防 cross-tenant 写）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR #115: journals user GET /:id 允许全局共享 row", () => {
  const src = readSrc("routes/journals.ts");

  it("import 含 isNull + or（drizzle helper）", () => {
    expect(src).toMatch(/import\s*\{[^}]*isNull[^}]*\}\s*from\s*["']drizzle-orm["']/);
    expect(src).toMatch(/import\s*\{[^}]*\bor\b[^}]*\}\s*from\s*["']drizzle-orm["']/);
  });

  it("GET /:id 用 or(isNull(tenantId), eq(tenantId, current))", () => {
    // 找 GET /:id handler 段（line 235-256 区域）
    const getHandler = src.match(/app\.get\("\/journals\/:id"[\s\S]*?\}\)\;/)?.[0] ?? "";
    expect(getHandler).toMatch(/or\(\s*isNull\(journals\.tenantId\)\s*,\s*eq\(journals\.tenantId,\s*tenantId\)\s*\)/);
  });

  it("含 PR #115 root cause 注释（防未来 refactor 误恢复严格 filter）", () => {
    expect(src).toMatch(/PR #115/);
    expect(src).toMatch(/全局共享|tenant_id NULL/);
  });
});

describe("PR #115: 安全边界 — PATCH/DELETE 仍保留严格 tenant filter", () => {
  const src = readSrc("routes/journals.ts");

  it("PATCH /:id 仍含 eq(journals.tenantId, tenantId) 严格过滤（防 user 改全局期刊）", () => {
    // 截取 PATCH /:id handler 起点到下一个 app.<verb>(... 起点之间的范围
    const patchStart = src.indexOf('app.patch("/journals/:id"');
    const nextHandler = src.slice(patchStart + 1).search(/app\.(get|post|put|patch|delete)\(/);
    const patchHandler = nextHandler > 0 ? src.slice(patchStart, patchStart + 1 + nextHandler) : src.slice(patchStart);
    expect(patchHandler).toMatch(/eq\(journals\.tenantId,\s*tenantId\)/);
    expect(patchHandler).not.toMatch(/or\(\s*isNull\(journals\.tenantId\)/);
  });
});
