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

  // 7-08 死测试清理 (确死: 读已删文件): 删 "HeroSection CTA: 一键生成图文 跳 /workbench" it —
  //   目标 apps/web/src/components/dashboard/HeroSection.tsx 已删 (dashboard redesign 撤除)。readSrc → ENOENT。
  //   "生成图文 → /workbench" 的路由意图现由 App.tsx 路由 + Sidebar/PrimaryActionBar CTA 承载 (其余 it / p0-sidebar 验证)。
  //   缓刑·已解除 (7-08): DistributionCard 断言查实为 6-11 有意重构瘦身(非功能丢失)——
  //      platform groupBy + isVerified 默认勾抽到 components/AccountSelector.tsx(实存, 前注释"仓内无此文件"有误);
  //      DVH 区块移出到 RecommendationCard / video/UnifiedVideoModal 的 DVH_TEMPLATES。
  //      断言已按现状拆两条(DistributionCard 委托 AccountSelector / AccountSelector 承接 groupBy), 均绿。

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

  it("DistributionCard: 账号选择收口到 AccountSelector + 发布按钮带 selectedCount", async () => {
    // 6-11 重构: DistributionCard 瘦身, platform groupBy + isVerified 默认勾逻辑抽到统一 <AccountSelector>;
    // 原 DVH 区块移出 (数字人生成归 RecommendationCard / UnifiedVideoModal 的 DVH_TEMPLATES)。
    // 断言更新到现状(非删): 卡片委托 AccountSelector + 保留 selectedCount 发布按钮。
    const card = await readSrc("../../../../apps/web/src/components/workbench/DistributionCard.tsx");
    expect(card).toMatch(/<AccountSelector/);
    expect(card).toMatch(/selectedCount/);
    expect(card).toMatch(/发布到 \$\{selectedCount\} 个账号/);
  });

  it("AccountSelector: 承接 platform groupBy + isVerified 默认勾选逻辑", async () => {
    // 上条重构的落点: groupBy/isVerified 逻辑现居 components/AccountSelector.tsx。
    const sel = await readSrc("../../../../apps/web/src/components/AccountSelector.tsx");
    expect(sel).toMatch(/grouped\b/);
    expect(sel).toMatch(/\.reduce/); // 按 platform groupBy
    expect(sel).toMatch(/isVerified/);
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
