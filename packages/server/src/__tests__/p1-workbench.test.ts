/**
 * 5-18 P1: 内容工坊 + 分发卡防回归。Web 无 testing-library, file-content 模式。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("5-18 P1: 内容工坊 + 分发卡", () => {
  it("App.tsx: /workbench → ContentWorkbenchPage, /recommendations Navigate redirect", async () => {
    const src = await readSrc("../../../../apps/web/src/App.tsx");
    expect(src).toMatch(/path="\/workbench"[\s\S]{0,200}<ContentWorkbenchPage/);
    expect(src).toMatch(/path="\/recommendations"\s+element={<Navigate to="\/workbench" replace/);
    expect(src).toMatch(/path="\/recommend-feed"[\s\S]{0,200}<RecommendationFeedPage/);
  });

  it("Sidebar (5-21 P0 全局 layout): 内容工坊 链接已配 (DashboardPage nav 搬 Sidebar)", async () => {
    // 5-21 P0: DashboardPage 顶部 nav 搬到 Sidebar (全局 MainLayout), 资产改在 Sidebar 验证
    const src = await readSrc("../../../../apps/web/src/components/layout/Sidebar.tsx");
    expect(src).toMatch(/to:\s*"\/workbench"/);
    expect(src).toMatch(/内容工坊/);
    expect(src).not.toMatch(/to:\s*"\/recommendations"/);
  });

  it("HeroSection CTA: 一键生成图文 跳 /workbench (不再 /recommendations)", async () => {
    const src = await readSrc("../../../../apps/web/src/components/dashboard/HeroSection.tsx");
    expect(src).toMatch(/to="\/workbench"[\s\S]{0,300}✨ 一键生成图文/);
    expect(src).not.toMatch(/to="\/recommendations"/);
  });

  it("ContentWorkbenchPage: 3 列布局 + 4 sub-component wire + 6 API endpoint", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentWorkbenchPage.tsx");
    expect(src).toMatch(/<ContentTabBar/);
    expect(src).toMatch(/<ContentListItem/);
    expect(src).toMatch(/<ContentPreviewPane/);
    expect(src).toMatch(/<DistributionCard/);
    // API 复用
    expect(src).toMatch(/\/content\/recommendations/);
    expect(src).toMatch(/\/content\?status=\$\{/);
    expect(src).toMatch(/\/content\/\$\{selectedId\}/);
    expect(src).toMatch(/\/accounts\?status=active/);
    expect(src).toMatch(/\/publish/);
    expect(src).toMatch(/\/generate-dvh-video/);
  });

  it("DistributionCard: 按 platform groupBy + 默认勾 isVerified + 发布按钮", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/DistributionCard.tsx");
    expect(src).toMatch(/PLATFORM_LABEL/);
    expect(src).toMatch(/grouped\b/);
    expect(src).toMatch(/selectedCount/);
    expect(src).toMatch(/发布到 \$\{selectedCount\} 个账号/);
    // 数字人区块复用 RecommendationCard 的 DVH_TEMPLATES
    expect(src).toMatch(/DVH_TEMPLATES/);
  });

  it("ContentTabBar: 3 tab + counts 实时", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/ContentTabBar.tsx");
    expect(src).toMatch(/"recommend"/);
    expect(src).toMatch(/"draft"/);
    expect(src).toMatch(/"published"/);
    expect(src).toMatch(/📅 今日推荐/);
    expect(src).toMatch(/✏️ 草稿/);
    expect(src).toMatch(/✅ 已发布/);
  });

  it("seed-hanxiao-accounts.ts 含 4 行 seed + idempotent 查重 + 复用 platformAccounts schema", async () => {
    const src = await readSrc("../scripts/seed-hanxiao-accounts.ts");
    expect(src).toMatch(/SEED_ROWS/);
    expect(src).toMatch(/主号 - 你好集团/);
    expect(src).toMatch(/学术号/);
    expect(src).toMatch(/credentials: \{\}/); // demo 空凭证
    expect(src).toMatch(/HANXIAO_TENANT_ID/);
    expect(src).toMatch(/existing\.length > 0/); // 幂等
  });
});
