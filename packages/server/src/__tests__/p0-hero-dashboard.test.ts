/**
 * 5-17 P0: 首页 hero 改造防回归。Web 无 testing-library 设施，file-content regression。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("5-17 P0: hero 改造 — 路由 / 后端 / 组件", () => {
  it("App.tsx: / → HomeRoute(今日驾驶舱), /home redirect", async () => {
    const src = await readSrc("../../../../apps/web/src/App.tsx");
    // 7-08 更新(测试过时/重构): / 落地页从 DashboardPage 改为 HomeRoute (按角色跳转, boss 落 MainLayout+TodayPage 今日驾驶舱)。
    expect(src).toMatch(/path="\/"[\s\S]{0,200}<HomeRoute/);
    // /home Navigate redirect 保留 (防老书签)
    expect(src).toMatch(/path="\/home"\s+element={<Navigate to="\/" replace/);
  });

  it("dashboard.ts /overview 含 todayHero block (含 5 字段)", async () => {
    const src = await readSrc("../routes/dashboard.ts");
    expect(src).toMatch(/SYSTEM_RECOMMENDATION_TENANT_ID/);
    expect(src).toMatch(/todayHero:\s*\{/);
    expect(src).toMatch(/systemTenantArticlesToday/);
    expect(src).toMatch(/pipeline24h/);
    expect(src).toMatch(/latestArticlePreview/);
    expect(src).toMatch(/recentPublished/);
    // 7-06 ④: 8500 假数据已拔 — totalReadsToday 改为真实回流聚合 (content_metrics.dailyReadDelta 求和)
    expect(src).not.toMatch(/totalReadsToday:\s*8500/);
    expect(src).toMatch(/dailyReadDelta/);
    expect(src).toMatch(/totalReadsToday:\s*Number/);
  });

  // 7-08 死测试清理 (确死: 读已删文件): 删 4 个 it —
  //   ① HeroSection.tsx ② Pipeline24hStrip.tsx ③ PreviewCardRow.tsx (三者均 apps/web/src/components/dashboard/*,
  //      已随 5-21→6-x dashboard redesign 删除, 主渲染改用 Greeting/KpiStrip/PrimaryActionBar/RecommendationPanel/LeadsPanel)
  //   ④ DashboardPage.tsx (已删, 首页合并进「今日驾驶舱」)。四者 readSrc 目标文件均不存在 → ENOENT, 断言无存活取代目标, 故删。
  //   保留: dashboard.ts /overview todayHero (后端, 活) + cost-comparison.ts util (活)。
  //   ⚠️ 缓刑 (未删, 待过目): 上方 "App.tsx: / → DashboardPage" it 读活文件 App.tsx 但断言已删页名, 需确认 / 的新落地页后更新, 未擅动。

  it("cost-comparison.ts 含 loadInputs/saveInputs export (HeroSection 复用)", async () => {
    const src = await readSrc("../../../../apps/web/src/utils/cost-comparison.ts");
    expect(src).toMatch(/export function loadInputs/);
    expect(src).toMatch(/export function saveInputs/);
    expect(src).toMatch(/export const STORAGE_KEY/);
  });
});
