/**
 * 5-17 P0: 首页 hero 改造防回归。Web 无 testing-library 设施，file-content regression。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("5-17 P0: hero 改造 — 路由 / 后端 / 组件", () => {
  it("App.tsx: / → DashboardPage, /home redirect", async () => {
    const src = await readSrc("../../../../apps/web/src/App.tsx");
    // / 走 DashboardPage
    expect(src).toMatch(/path="\/"[\s\S]{0,200}<DashboardPage/);
    // /home Navigate redirect (不再渲染 DashboardPage)
    expect(src).toMatch(/path="\/home"\s+element={<Navigate to="\/" replace/);
    // 注：/recommendations 路由从「→ RecommendationFeedPage」改为「Navigate redirect /workbench」(P1 5-18 接管)
  });

  it("dashboard.ts /overview 含 todayHero block (含 5 字段)", async () => {
    const src = await readSrc("../routes/dashboard.ts");
    expect(src).toMatch(/SYSTEM_RECOMMENDATION_TENANT_ID/);
    expect(src).toMatch(/todayHero:\s*\{/);
    expect(src).toMatch(/systemTenantArticlesToday/);
    expect(src).toMatch(/pipeline24h/);
    expect(src).toMatch(/latestArticlePreview/);
    expect(src).toMatch(/recentPublished/);
    expect(src).toMatch(/totalReadsToday:\s*8500/); // hardcode with TODO
  });

  it("HeroSection.tsx 含今日产出 + 双 CTA (5-21 hotfix: ROI 卡已搬 /cost-comparison)", async () => {
    const src = await readSrc("../../../../apps/web/src/components/dashboard/HeroSection.tsx");
    expect(src).toMatch(/今日 BossMate 自动产出/);
    expect(src).toMatch(/✨ 一键生成图文/);
    expect(src).toMatch(/🎬 一键生成视频/);
    // 双 CTA 跳转 (P1 5-18: ✨ 一键生成图文 → /workbench)
    expect(src).toMatch(/to="\/workbench"/);
    expect(src).toMatch(/to="\/video\/create"/);
    // 5-21 hotfix: ROI/月省 不在 hero
    expect(src).not.toMatch(/本月帮你节省/);
    expect(src).not.toMatch(/monthlySavings/);
  });

  it("Pipeline24hStrip 含 4 段 + 系统/你 归属标签", async () => {
    const src = await readSrc("../../../../apps/web/src/components/dashboard/Pipeline24hStrip.tsx");
    expect(src).toMatch(/keywordsCrawled/);
    expect(src).toMatch(/articlesGenerated/);
    expect(src).toMatch(/articlesPublished/);
    expect(src).toMatch(/totalReadsToday/);
    // 系统 vs 你 归属 (5-17 决策 3)
    expect(src).toMatch(/scope:\s*"系统"/);
    expect(src).toMatch(/scope:\s*"你"/);
  });

  it("PreviewCardRow 含 2 卡 + emoji fallback (5-21 hotfix: 砍中间 ROI 卡, 改 2 列 50/50)", async () => {
    const src = await readSrc("../../../../apps/web/src/components/dashboard/PreviewCardRow.tsx");
    expect(src).toMatch(/📰 今日最新/);
    expect(src).toMatch(/📈 近期发布/);
    expect(src).toMatch(/grid-cols-2/);
    // emoji fallback when coverUrl null
    expect(src).toMatch(/latestArticle\?\.coverUrl/);
    // 5-21 hotfix: ROI 卡已删
    expect(src).not.toMatch(/💰 本月 ROI/);
    expect(src).not.toMatch(/monthlySavings/);
  });

  it("DashboardPage 函数定义保留 (revert safety), 主 render 不再调", async () => {
    // 5-21 P0: 全 redesign — 老 HeroSection/Pipeline24hStrip/PreviewCardRow 已撤出主 render, 改用
    // Greeting + KpiStrip + PrimaryActionBar + RecommendationPanel + LeadsPanel (见 p0-sidebar-layout.test.ts)。
    // 老组件文件本身仍存在 (本测试文件上方 5 个 it 仍验证), 仅 DashboardPage 不再 import / 主渲染。
    const src = await readSrc("../../../../apps/web/src/pages/DashboardPage.tsx");
    expect(src).not.toMatch(/^\s*<HeroSection/m);
    expect(src).not.toMatch(/^\s*<Pipeline24hStrip/m);
    expect(src).not.toMatch(/^\s*<PreviewCardRow/m);
    expect(src).not.toMatch(/^\s*<PendingReviewQueue/m);
    expect(src).not.toMatch(/^\s*<TopicStrip/m);
    // PR Q.7 防回归: <FactoryHero /> 注释保留
    expect(src).toMatch(/\{\s*\/\*\s*<FactoryHero \/>\s*\*\/\s*\}/);
    // 5-21 P0 dead-code 函数定义保留, 方便 revert
    expect(src).toMatch(/function FactoryHero\b/);
    expect(src).toMatch(/function PendingReviewQueue\b/);
    expect(src).toMatch(/function TopicStrip\b/);
  });

  it("cost-comparison.ts 含 loadInputs/saveInputs export (HeroSection 复用)", async () => {
    const src = await readSrc("../../../../apps/web/src/utils/cost-comparison.ts");
    expect(src).toMatch(/export function loadInputs/);
    expect(src).toMatch(/export function saveInputs/);
    expect(src).toMatch(/export const STORAGE_KEY/);
  });
});
