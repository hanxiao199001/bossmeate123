/**
 * 5-21 P3 防回归: chat 抽屉 + 销售雷达 + seed-demo-leads。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("5-21 P3 — backend 改动", () => {
  it("sales.ts /stats 加 3 字段 todayNew/weekWarm/monthConverted (additive)", async () => {
    const src = await readSrc("../routes/sales.ts");
    expect(src).toMatch(/todayNew/);
    expect(src).toMatch(/weekWarm/);
    expect(src).toMatch(/monthConverted/);
    // 老字段保留
    expect(src).toMatch(/totalLeads/);
    expect(src).toMatch(/unreadLeads/);
  });

  it("sales.ts /leads stage 支持多值 (热 tab = qualified,negotiating,need_human)", async () => {
    const src = await readSrc("../routes/sales.ts");
    expect(src).toMatch(/inArray/);
    expect(src).toMatch(/stage\.split\(/);
  });

  it("seed-demo-leads.ts 含 5 stage seed (new/qualified/negotiating/won/lost) + metadata 标记", async () => {
    const src = await readSrc("../scripts/seed-demo-leads.ts");
    expect(src).toMatch(/SEED_LEADS/);
    expect(src).toMatch(/stage:\s*"new"/);
    expect(src).toMatch(/stage:\s*"qualified"/);
    expect(src).toMatch(/stage:\s*"negotiating"/);
    expect(src).toMatch(/stage:\s*"won"/);
    expect(src).toMatch(/stage:\s*"lost"/);
    expect(src).toMatch(/seedSource:\s*"demo"/);
    expect(src).toMatch(/HANXIAO_TENANT_ID/);
    // 幂等
    expect(src).toMatch(/existing\.length > 0/);
    // 写 sales_messages 表
    expect(src).toMatch(/salesMessages/);
  });
});

describe("5-21 P3 — frontend", () => {
  it("App.tsx mount ChatFab + ChatDrawer 全局 (isAuthenticated 守卫)", async () => {
    const src = await readSrc("../../../../apps/web/src/App.tsx");
    expect(src).toMatch(/<ChatFab/);
    expect(src).toMatch(/<ChatDrawer/);
    expect(src).toMatch(/isAuthenticated &&/);
    // 新路由
    expect(src).toMatch(/path="\/sales-radar"[\s\S]{0,200}<SalesRadarPage/);
  });

  it("SalesRadarPage 含 hero 3 大数字 + 5 tabs + intentScore badge", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/SalesRadarPage.tsx");
    expect(src).toMatch(/todayNew/);
    expect(src).toMatch(/weekWarm/);
    expect(src).toMatch(/monthConverted/);
    // 5 tabs
    expect(src).toMatch(/TABS/);
    expect(src).toMatch(/❄ 冷/);
    expect(src).toMatch(/🔥 热/);
    expect(src).toMatch(/✅ 转化/);
    expect(src).toMatch(/已流失/);
    // 评分 badge
    expect(src).toMatch(/scoreBadge/);
    // 热 tab 用多值 stage
    expect(src).toMatch(/qualified,negotiating,need_human/);
  });

  it("ChatDrawer + ChatPanel + ChatFab 三组件存在", async () => {
    const fab = await readSrc("../../../../apps/web/src/components/chat-drawer/ChatFab.tsx");
    const drawer = await readSrc("../../../../apps/web/src/components/chat-drawer/ChatDrawer.tsx");
    const panel = await readSrc("../../../../apps/web/src/components/chat-drawer/ChatPanel.tsx");
    expect(fab).toMatch(/💬/);
    expect(drawer).toMatch(/Escape/); // ESC 关
    expect(drawer).toMatch(/onClose/);
    expect(panel).toMatch(/\/chat\/conversations/); // 复用 chat.ts API
    expect(panel).toMatch(/LAST_CONV_KEY/); // localStorage 续上次
    expect(panel).toMatch(/SKILLS/); // 4 skill dropdown
  });

  it("Sidebar (5-21 P0 全局 layout): 销售雷达 链接已配 (Dashboard/Workbench nav 搬 Sidebar)", async () => {
    // 5-21 P0: Dashboard/Workbench 顶部 nav 搬到 Sidebar, 销售雷达 链接在 Sidebar.PRIMARY_NAV
    const src = await readSrc("../../../../apps/web/src/components/layout/Sidebar.tsx");
    expect(src).toMatch(/to:\s*"\/sales-radar"/);
    expect(src).toMatch(/销售雷达/);
  });
});
