/** B.7-A: 订阅号 passive XML 回复 — content + XML 结构 + URL fallback. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://t/t" } }));

let tenantUrl: string | null = null;
vi.mock("../models/db.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => tenantUrl !== null ? [{ url: tenantUrl }] : [] }) }) }) },
}));

const { loadBossmateUrl, buildPassiveReplyContent, buildPassiveReplyXml } = await import("../services/wechat/passive-reply.js");

describe("B.7-A passive reply", () => {
  it("buildPassiveReplyContent 注入 URL + 含小王 + 3 秒匹配", () => {
    const c = buildPassiveReplyContent("https://x.tld/y");
    expect(c).toContain("https://x.tld/y");
    expect(c).toContain("BossMate 客服小王");
    expect(c).toContain("3 秒");
  });

  it("buildPassiveReplyXml 微信被动回复 XML 5 节点 + CDATA + ToUser/FromUser 互换", () => {
    const xml = buildPassiveReplyXml({ fromUser: "oUserOpenId", toUser: "gh_xxx", content: "hello" });
    // 5 节点：ToUserName / FromUserName / CreateTime / MsgType / Content
    expect(xml).toMatch(/<ToUserName><!\[CDATA\[oUserOpenId\]\]>/);    // 客户 OpenID 当 ToUser（互换）
    expect(xml).toMatch(/<FromUserName><!\[CDATA\[gh_xxx\]\]>/);        // 公众号 gh_xxx 当 FromUser
    expect(xml).toMatch(/<MsgType><!\[CDATA\[text\]\]>/);
    expect(xml).toMatch(/<Content><!\[CDATA\[hello\]\]>/);
    expect(xml).toMatch(/<CreateTime>\d+<\/CreateTime>/);
  });

  it("loadBossmateUrl tenant 配置 → 返实际 URL", async () => {
    tenantUrl = "https://custom.tld/x";
    expect(await loadBossmateUrl("t-1")).toBe("https://custom.tld/x");
  });

  it("loadBossmateUrl tenant 无记录 → fallback 默认", async () => {
    tenantUrl = null;
    expect(await loadBossmateUrl("t-2")).toBe("https://bossmate.app/try");
  });
});
