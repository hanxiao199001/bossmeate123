/**
 * PR #112（5-10 清理日 2）：全代码 tenant filter 审查 + 防回归。
 *
 * 5-9 PR #110 hotfix root cause 复盘：
 *   journals 是 PR B.12 设计的全局共享参考数据（tenant_id NULL = 共享）。
 *   admin route 加了 eq(journals.tenantId, request.tenantId) 过滤 → NULL ≠ UUID → 0 命中。
 *
 * 本 PR 审查全代码 tenant filter（grep 14 处 journals tenant filter）：
 *   - routes/journals-audit.ts (admin only) → PR #110 已砍 ✅
 *   - routes/journals.ts × 10 + topic.ts × 3 + workflow.ts × 1 (user routes) → 按 spec "保留 user 路由"
 *   - routes/templates.ts content_templates → 已正确用 or(isNull, eq) ✅
 *
 * 本 test 锁定:
 *   1. admin/journals/audit 路由 0 tenant filter（防未来 refactor 误恢复）
 *   2. content_templates 仍用 or(isNull, eq) 模式（防被改成单 eq）
 *   3. PR #110 注释存在（解释 B.12 全局共享设计）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR #112: admin audit route 0 tenant filter（PR #110 修复）", () => {
  const audit = readSrc("routes/journals-audit.ts");

  it("audit route 不再有 eq(journals.tenantId, request.tenantId) 字面", () => {
    expect(audit).not.toMatch(/eq\(journals\.tenantId,\s*request\.tenantId\)/);
  });

  it("audit route 含 PR #110 root cause 注释（防 refactor 误恢复）", () => {
    expect(audit).toMatch(/PR #110/);
  });

  it("admin role guard 3 处仍在", () => {
    expect(audit.match(/if\s*\(!isAdmin\(request\.user\.role\)\)/g)?.length).toBe(3);
  });
});

describe("PR #112: content_templates 用 or(isNull, eq) 全局共享模式（templates.ts）", () => {
  const tpl = readSrc("routes/templates.ts");

  it("tenant filter 用 or(isNull(tenantId), eq(tenantId, current)) 模式（让 user 看到全局 + 自定义）", () => {
    // user 看到 NULL（系统模板）+ 自己 tenant 的（非 NULL）
    expect(tpl).toMatch(
      /or\(isNull\(contentTemplates\.tenantId\),\s*eq\(contentTemplates\.tenantId,\s*request\.tenantId\)\)/,
    );
  });

  it("出现至少 2 次（list + detail 均使用）", () => {
    const matches = tpl.match(/or\(isNull\(contentTemplates\.tenantId\)/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("PR #112: known issue 标记 — user 路由 journals tenant filter（spec 保留）", () => {
  it("routes/journals.ts list 仍含 user tenant filter（spec 红线 #6 保留 user 路由）", () => {
    const j = readSrc("routes/journals.ts");
    // 仍含 eq(journals.tenantId, tenantId) — spec 明示保留 user 视角
    expect(j).toMatch(/eq\(journals\.tenantId,\s*tenantId\)/);
  });

  /**
   * 已知未来工作（不在本 PR 范围）：
   * journals 是全局共享数据，user 路由理论上应改为 or(isNull, eq) 让 user 看到全局期刊。
   * spec 红线 #6 "不扩 scope" → 留给后续 sprint（如 PR #115+）。
   */
  it("此 known issue 已在测试中标记（spec 保留 user 路由的设计选择）", () => {
    expect(true).toBe(true); // 文档锚点
  });
});
