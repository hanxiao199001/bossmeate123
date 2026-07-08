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

  it("App.tsx: 4 demo + /cost-comparison + /chat 6 路由已包 MainLayout (5-23 PR #156 收尾)", async () => {
    const src = await readSrc("../../../../apps/web/src/App.tsx");
    expect(src).toMatch(/import\s+MainLayout/);
    // 4 demo 路由 (PR #153)
    expect(src).toMatch(/path="\/"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<DashboardPage/);
    expect(src).toMatch(/path="\/workbench"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<ContentWorkbenchPage/);
    expect(src).toMatch(/path="\/sales-radar"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<SalesRadarPage/);
    expect(src).toMatch(/path="\/content\/:id"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<ContentDetailPage/);
    // PR #156 收尾的 2 页 (cost-comparison + chat × 2 路由)
    expect(src).toMatch(/path="\/cost-comparison"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<CostComparisonPage/);
    expect(src).toMatch(/path="\/chat"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<ChatPage/);
    expect(src).toMatch(/path="\/chat\/:conversationId"[\s\S]{0,300}<MainLayout>[\s\S]{0,100}<ChatPage/);
  });

  it("5-23 PR #156: CostComparisonPage 已砍内联 nav", async () => {
    // 7-08 死测试清理 (死活混装拆分): 原 it 同时读 CostComparisonPage(活) + ChatPage(已删)。
    //   ChatPage.tsx 已删 (/chat 整页下线) → 那半 readSrc ENOENT 拖垮整 it。已摘除 ChatPage 断言块 (nav/sidebarOpen toggle/skill 标签),
    //   保留 CostComparisonPage 的活断言 (该页仍存在)。
    const cost = await readSrc("../../../../apps/web/src/pages/CostComparisonPage.tsx");
    expect(cost).not.toMatch(/<nav\b/);
    expect(cost).not.toMatch(/← 返回首页/);
    expect(cost).not.toMatch(/^import.*useAuthStore/m); // user/logout 搬 sidebar — 无 import (注释提及不算)
    // 留 1 行简化 header
    expect(cost).toMatch(/💰 价值对比/);
  });

  // 7-08 死测试清理 (确死: 读已删文件): 删 3 个 DashboardPage.tsx it —
  //   ① "主 render 用新 5 组件" ② "empty state 触发条件" ③ "recItems mapping coverUrl fallback"。
  //   目标 apps/web/src/pages/DashboardPage.tsx 已删 (首页合并进「今日驾驶舱」)。三者 readSrc → ENOENT, 无取代页可断言。
  //   新首页各子组件 (PrimaryActionBar/RecommendationPanel/LeadsPanel) 的活断言在本文件其余 it 保留。
  //   ⚠️ 缓刑 (未删, 待过目, 属"活文件内容漂移"非读已删文件):
  //      · "MainLayout 包 Sidebar" — 现 MainLayout 为 <main ml-52> (断言要 ml-40); sidebar 宽度 6-x 从 160→208px, 疑测试过时。
  //      · "Sidebar 含 4 主导航" — 现标签「今日/内容工坊/销售雷达/账号矩阵」(断言要「首页…账号」); 6-14 目录重构改名, 疑测试过时。
  //      · "App.tsx: 6 路由已包 MainLayout" — 断言含已删页 DashboardPage/ChatPage 路由, 需按新路由更新。
  //      以上均需你确认现状是有意重构后再更新断言, 未擅动。

  it("PrimaryActionBar: normal/empty 双模都含 CTA", async () => {
    const src = await readSrc("../../../../apps/web/src/components/dashboard/PrimaryActionBar.tsx");
    expect(src).toMatch(/打开内容工坊/);
    expect(src).toMatch(/跟进销售线索/);
    expect(src).toMatch(/今天还没开始/); // empty mode
    expect(src).toMatch(/一键启动今日产出/); // empty CTA
    expect(src).toMatch(/to="\/workbench"/);
    expect(src).toMatch(/to="\/sales-radar"/);
  });

  // 7-08 死测试清理 (确死: 读已删文件): "DashboardPage recItems mapping coverUrl fallback" it 已删 (见上方 DashboardPage 清理注释)。
  //   目标 DashboardPage.tsx 已删; coverUrl fallback 若在新首页仍需守护, 应在取代组件 (RecommendationPanel) 上另立断言。

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
