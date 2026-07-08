/**
 * PR #111（5-10 清理日 1）：audit 页 nav link + 全局横幅。
 * 防回归 — 锁定 DashboardPage 含 admin only 入口 + AuditPage 含 conditional banner。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readWeb(rel: string): string {
  return readFileSync(join(__dirname, "../../../../apps/web/src", rel), "utf8");
}

describe("PR #111: 期刊审计入口（admin only） — 5-21 P0 从 DashboardPage ToolGrid 搬到 Sidebar", () => {
  const src = readWeb("components/layout/Sidebar.tsx");

  it("Sidebar 含 isAdmin role check", () => {
    expect(src).toMatch(/role === "owner".*role === "admin"|isAdmin\s*=/);
  });

  it("admin 时 sidebar 含 /admin/journals/audit 入口", () => {
    expect(src).toMatch(/to:\s*"\/admin\/journals\/audit"/);
    expect(src).toMatch(/期刊审计/);
  });

  // ⚠️ 7-08 缓刑 (未删, 待过目, 属"实现细节演进"非读已删文件):
  //   下方 it 断言旧实现 `isAdmin ? [...]` 数组 spread。现 Sidebar (6-14 目录重构) 改为 nav item 带 `adminOnly: true`
  //   + 统一过滤 `if (i.adminOnly && !isAdmin) return false`——admin-only 期刊审计入口的**功能仍在** (上方两个 it 已验证入口存在),
  //   只是隐藏机制从"条件 spread"变成"声明式过滤"。属测试过时而非功能丢失; 应更新断言到 `adminOnly.*true` + 过滤逻辑, 而非删。未擅动, 待你拍。
  it("非 admin 时不渲染该入口（isAdmin 条件 spread）", () => {
    expect(src).toMatch(/isAdmin\s*\?\s*\[/);
  });
});

describe("PR #111: AdminJournalsAuditPage 全局横幅", () => {
  const src = readWeb("pages/AdminJournalsAuditPage.tsx");

  it("含 conditional banner（high+mid 全 0 时显示）", () => {
    expect(src).toMatch(/highConfidence\s*\+\s*stats\.midConfidence\s*===\s*0/);
  });

  it("横幅含 enricher 状态提示文案 + 03:00 cron 引导", () => {
    expect(src).toMatch(/当前.*期刊均未经 enricher 验证/);
    expect(src).toMatch(/03:00.*cron|cron.*03:00/);
  });

  it("横幅含 🔄 重新验证 操作引导", () => {
    expect(src).toMatch(/🔄 重新验证/);
  });
});
