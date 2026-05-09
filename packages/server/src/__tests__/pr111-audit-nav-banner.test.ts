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

describe("PR #111: DashboardPage ToolGrid 加期刊审计入口（admin only）", () => {
  const src = readWeb("pages/DashboardPage.tsx");

  it("ToolGrid 含 isAdmin role check", () => {
    expect(src).toMatch(/role === "owner".*role === "admin"|isAdmin\s*=/);
  });

  it("admin 时 grid 加 /admin/journals/audit 入口", () => {
    expect(src).toMatch(/to:\s*"\/admin\/journals\/audit"/);
    expect(src).toMatch(/期刊审计/);
  });

  it("非 admin 时不渲染该入口（条件展开）", () => {
    expect(src).toMatch(/isAdmin[\s\S]*?\?\s*\[/);
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
