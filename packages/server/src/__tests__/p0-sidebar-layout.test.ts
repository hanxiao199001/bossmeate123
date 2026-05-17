/**
 * 5-21 P0 全 redesign 防回归 — Sidebar 全局 layout + Dashboard 重构 + 4 demo 页 nav 去除。
 * Web 无 testing-library, file-content regression。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("5-21 P0: Sidebar 全局 layout 重构", () => {
  it("MainLayout 包 Sidebar + main", async () => {
    const src = await readSrc("../../../../apps/web/src/components/layout/MainLayout.tsx");
    expect(src).toMatch(/import\s+Sidebar/);
    expect(src).toMatch(/<Sidebar\s*\/>/);
    expect(src).toMatch(/<main[\s\S]*ml-40/); // sidebar 160px → main 左 margin
  });

  it("Sidebar 含 4 主导航 (首页/工坊/雷达/账号) + 用户区", async () => {
    const src = await readSrc("../../../../apps/web/src/components/layout/Sidebar.tsx");
    expect(src).toMatch(/首页/);
    expect(src).toMatch(/内容工坊/);
    expect(src).toMatch(/销售雷达/);
    expect(src).toMatch(/账号/);
    expect(src).toMatch(/to:\s*"\/workbench"/);
    expect(src).toMatch(/to:\s*"\/sales-radar"/);
    expect(src).toMatch(/to:\s*"\/accounts"/);
    expect(src).toMatch(/useAuthStore/);
    expect(src).toMatch(/logout/);
    // 固定左侧 160px (w-40), z-30 让 chat FAB (z-40) 浮上面
    expect(src).toMatch(/fixed[\s\S]*left-0[\s\S]*w-40/);
    expect(src).toMatch(/z-30/);
  });

  it("App.tsx: 4 demo 路由 (/ /workbench /sales-radar /content/:id) 已包 MainLayout", async () => {
    const src = await readSrc("../../../../apps/web/src/App.tsx");
    expect(src).toMatch(/import\s+MainLayout/);
    // 4 demo 路由都包
    expect(src).toMatch(/path="\/"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<DashboardPage/);
    expect(src).toMatch(/path="\/workbench"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<ContentWorkbenchPage/);
    expect(src).toMatch(/path="\/sales-radar"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<SalesRadarPage/);
    expect(src).toMatch(/path="\/content\/:id"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<ContentDetailPage/);
  });

  it("DashboardPage: 主 render 用新 5 组件 (Greeting/KpiStrip/PrimaryActionBar/RecommendationPanel/LeadsPanel)", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/DashboardPage.tsx");
    expect(src).toMatch(/<Greeting\s/);
    expect(src).toMatch(/<KpiStrip\s/);
    expect(src).toMatch(/<PrimaryActionBar\s/);
    expect(src).toMatch(/<RecommendationPanel\s/);
    expect(src).toMatch(/<LeadsPanel\s/);
    // 老 hero 主 render 已撤 (函数定义保留 dead code)
    expect(src).not.toMatch(/^\s*<HeroSection[\s/]/m);
    expect(src).not.toMatch(/^\s*<Pipeline24hStrip[\s/]/m);
    expect(src).not.toMatch(/^\s*<PreviewCardRow[\s/]/m);
    // 没有内联 <nav> (搬 sidebar 了)
    expect(src).not.toMatch(/<nav\b/);
    // 4 KPI key 在 kpis 数组
    expect(src).toMatch(/key:\s*"today"/);
    expect(src).toMatch(/key:\s*"rec"/);
    expect(src).toMatch(/key:\s*"warm"/);
    expect(src).toMatch(/key:\s*"converted"/);
  });

  it("DashboardPage: empty state 触发条件 (isEmpty → PrimaryActionBar mode='empty')", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/DashboardPage.tsx");
    expect(src).toMatch(/isEmpty\s*=/);
    expect(src).toMatch(/isEmpty\s*\?\s*"empty"\s*:\s*"normal"/);
  });

  it("PrimaryActionBar: normal/empty 双模都含 CTA", async () => {
    const src = await readSrc("../../../../apps/web/src/components/dashboard/PrimaryActionBar.tsx");
    expect(src).toMatch(/打开内容工坊/);
    expect(src).toMatch(/跟进销售线索/);
    expect(src).toMatch(/今天还没开始/); // empty mode
    expect(src).toMatch(/一键启动今日产出/); // empty CTA
    expect(src).toMatch(/to="\/workbench"/);
    expect(src).toMatch(/to="\/sales-radar"/);
  });

  it("RecommendationPanel + LeadsPanel: 含 empty state 文案 (引导而非冷漠)", async () => {
    const recSrc = await readSrc("../../../../apps/web/src/components/dashboard/RecommendationPanel.tsx");
    expect(recSrc).toMatch(/暂无新推荐/);
    expect(recSrc).toMatch(/去内容工坊查看历史/);
    const leadSrc = await readSrc("../../../../apps/web/src/components/dashboard/LeadsPanel.tsx");
    expect(leadSrc).toMatch(/还没有线索来咨询/);
    expect(leadSrc).toMatch(/进销售雷达看历史/);
  });

  it("3 迁移页 (Workbench/SalesRadar/ContentDetail) 已去掉冗余 nav 链接", async () => {
    const wb = await readSrc("../../../../apps/web/src/pages/ContentWorkbenchPage.tsx");
    expect(wb).not.toMatch(/className="text-sm font-medium text-blue-600">📝 内容工坊/);
    expect(wb).not.toMatch(/Link to="\/sales-radar"/);
    const sr = await readSrc("../../../../apps/web/src/pages/SalesRadarPage.tsx");
    expect(sr).not.toMatch(/Link to="\/"/);
    expect(sr).not.toMatch(/Link to="\/workbench"/);
    const cd = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    // user/logout 已挪
    expect(cd).not.toMatch(/onClick=\{logout\}/);
  });
});
