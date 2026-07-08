/**
 * 获客-1: 公众号关注回复 + 被动回复加客服入口。
 * 漏点: subscribe 事件无 MsgId, 旧 parseWechatXml 缺字段抛错 → 新粉白流失。
 * 修: 接住 subscribe → 欢迎语(平台 URL + 企微客服入口); 取关静默; 文本消息被动回复也带客服入口。
 */
import { describe, it, expect } from "vitest";
import { parseWechatXml } from "../services/wechat/inbound-parser.js";
import { buildWelcomeContent, buildPassiveReplyContent } from "../services/wechat/passive-reply.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

const KF = "https://work.weixin.qq.com/kf/kfcTEST";
const URL_ = "https://boss-mate.cn/try";
const evtXml = (event: string) =>
  `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[oUser1]]></FromUserName><CreateTime>123</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event}]]></Event></xml>`;

describe("parseWechatXml — event 事件(无 MsgId 不再抛错)", () => {
  it("subscribe 事件(无 MsgId) → 正常解析, event=subscribe", () => {
    const p = parseWechatXml(evtXml("subscribe"));
    expect(p.msgType).toBe("event");
    expect(p.event).toBe("subscribe");
    expect(p.fromUser).toBe("oUser1");
  });
  it("unsubscribe 事件 → event=unsubscribe", () => {
    expect(parseWechatXml(evtXml("unsubscribe")).event).toBe("unsubscribe");
  });
  it("普通文本消息缺 MsgId → 仍抛错(非 event 仍要求 MsgId)", () => {
    const noId = `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[oUser1]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content></xml>`;
    expect(() => parseWechatXml(noId)).toThrow();
  });
});

describe("欢迎语 / 被动回复文案", () => {
  it("欢迎语含平台 URL + 企微客服入口", () => {
    const c = buildWelcomeContent(URL_, KF);
    expect(c).toContain(URL_);
    expect(c).toContain(KF);
    expect(c).toContain("联系客服");
  });
  it("被动回复(文本消息)含平台 URL + 客服入口", () => {
    const c = buildPassiveReplyContent(URL_, KF);
    expect(c).toContain(URL_);
    expect(c).toContain(KF);
  });
  it("kfUrl 为空 → 文案不含客服行(优雅降级)", () => {
    expect(buildWelcomeContent(URL_, "")).not.toContain("联系客服");
    expect(buildPassiveReplyContent(URL_, "")).not.toContain("联系客服");
  });
});

describe("callback wire 防回归", () => {
  it("subscribe → 欢迎语 XML; 其余 event → 静默 ack('')", async () => {
    const src = await readSrc("../routes/wechat-callback.ts");
    expect(src).toMatch(/parsed\.event === "subscribe"/);
    expect(src).toMatch(/buildWelcomeContent\(url, loadKfUrl\(\)\)/);
    // event 分支里非 subscribe 走 send("")
    const evtIdx = src.indexOf('parsed.msgType === "event"');
    const textIdx = src.indexOf('parsed.msgType !== "text"');
    expect(evtIdx).toBeGreaterThan(-1);
    expect(evtIdx).toBeLessThan(textIdx); // event 处理排在非 text 兜底之前
  });
});
