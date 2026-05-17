/**
 * 5-20 P2 — 风控审核单测 (pure function) + file-content regression。
 */
import { describe, it, expect } from "vitest";
import { auditContent } from "../services/risk-control/audit-content.js";
import { getDictForPlatform } from "../services/risk-control/dictionaries/index.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("auditContent — pure function 跨平台扫描", () => {
  // 5-22 hotfix #154: dict 精化后, 测试 fixture 改用新精确短语
  it("微信平台命中『扫码免费领』+『加微』", async () => {
    const r = await auditContent({
      content: { title: "学术期刊扫码免费领模板", body: "加微 wx123 获取" },
      platforms: ["wechat"],
    });
    const words = r.hits.map((h) => h.word);
    expect(words).toContain("扫码免费领");
    expect(words).toContain("加微");
    expect(r.summary.byPlatform.wechat).toBeGreaterThanOrEqual(2);
  });

  it("抖音命中跨平台导流『WeChat:』『vx:』", async () => {
    const r = await auditContent({
      content: { title: "投稿攻略", body: "评论区 WeChat: 123, vx: abc 联系" },
      platforms: ["douyin"],
    });
    const words = r.hits.map((h) => h.word);
    expect(words).toContain("WeChat:");
    expect(words).toContain("vx:");
  });

  it("视频号继承 wechat 营销底线（『扫码免费领』）+ 自身专有（『跳转抖音』）", async () => {
    const r = await auditContent({
      content: { title: "扫码免费领教程", body: "请跳转抖音观看" },
      platforms: ["wechat_video"],
    });
    const words = r.hits.map((h) => h.word);
    expect(words).toContain("扫码免费领");
    expect(words).toContain("跳转抖音");
  });

  it("跨平台多命中: positions 字符级偏移正确", async () => {
    const r = await auditContent({
      content: { title: null, body: "扫码免费领 abc 扫码免费领 xyz 扫码免费领" },
      platforms: ["wechat"],
    });
    const hit = r.hits.find((h) => h.word === "扫码免费领");
    expect(hit).toBeDefined();
    expect(hit!.positions.length).toBe(3);
  });

  it("干净内容 → 0 hits", async () => {
    const r = await auditContent({
      content: { title: "Nature 期刊投稿指引", body: "本期推荐学术论文 8 篇" },
      platforms: ["wechat", "douyin"],
    });
    expect(r.summary.totalHits).toBe(0);
  });

  it("未知平台只走 common dict，不爆炸", async () => {
    const dict = getDictForPlatform("unknown_platform");
    expect(Array.isArray(dict)).toBe(true);
    expect(dict.length).toBeGreaterThan(0);
  });

  it("『最便宜』(广告法绝对化) 跨平台都命中 (common dict)", async () => {
    const r = await auditContent({
      content: { title: null, body: "本号是最便宜的" },
      platforms: ["wechat", "douyin", "wechat_video"],
    });
    expect(r.summary.byPlatform.wechat).toBeGreaterThanOrEqual(1);
    expect(r.summary.byPlatform.douyin).toBeGreaterThanOrEqual(1);
    expect(r.summary.byPlatform.wechat_video).toBeGreaterThanOrEqual(1);
  });
});

describe("5-20 P2 — wire 防回归", () => {
  it("PublishRequest 含 forceOverride/overrideReason", async () => {
    const src = await readSrc("../services/publisher/index.ts");
    expect(src).toMatch(/forceOverride\?:\s*boolean/);
    expect(src).toMatch(/overrideReason\?:\s*string/);
  });

  it("PublishResult 含 status='blocked' + riskHits 扩展字段", async () => {
    const src = await readSrc("../services/publisher/index.ts");
    expect(src).toMatch(/status\?:\s*"blocked"/);
    expect(src).toMatch(/riskHits\?:\s*AuditHit\[\]/);
  });

  it("publishToAccounts 调 auditContent + 命中 blocked 返回", async () => {
    const src = await readSrc("../services/publisher/index.ts");
    expect(src).toMatch(/auditContent\(/);
    expect(src).toMatch(/status:\s*"blocked"/);
    expect(src).toMatch(/!req\.forceOverride/);
  });

  it("POST /publish 接受 forceOverride 透传", async () => {
    const src = await readSrc("../routes/accounts.ts");
    expect(src).toMatch(/forceOverride:\s*z\.boolean\(\)\.optional/);
    expect(src).toMatch(/forceOverride:\s*body\.forceOverride/);
  });

  it("POST /content/:id/audit endpoint 存在", async () => {
    const src = await readSrc("../routes/content.ts");
    expect(src).toMatch(/\/:id\/audit/);
    expect(src).toMatch(/auditContent\(/);
  });

  it("RiskAuditModal 含 3 选 1 按钮 + 强制放行二次确认", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/RiskAuditModal.tsx");
    expect(src).toMatch(/✏️ 改文案/);
    expect(src).toMatch(/⏭ 跳过有风险的账号/);
    expect(src).toMatch(/⚠️ 强制放行/);
    expect(src).toMatch(/showOverrideForm/);
    expect(src).toMatch(/overrideReason\.trim\(\)\.length < 10/);
  });

  it("ContentWorkbenchPage wire RiskAuditModal + audit 接口 + 3 回调", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentWorkbenchPage.tsx");
    expect(src).toMatch(/RiskAuditModal/);
    expect(src).toMatch(/\/audit/);
    expect(src).toMatch(/handleAuditEdit/);
    expect(src).toMatch(/handleAuditSkipRisky/);
    expect(src).toMatch(/handleAuditForceOverride/);
    expect(src).toMatch(/forceOverride:\s*true/);
  });
});
