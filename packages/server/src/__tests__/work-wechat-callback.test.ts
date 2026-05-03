/** B.2: 企业微信 inbound 单测 — AES round-trip + msg_signature ×3 + 解析 ×3。 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k".repeat(32), LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://test/test" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../models/db.js", () => ({ db: {} }));

const { computeMsgSignature, encrypt, decrypt } = await import("../services/work-wechat/crypto.js");
const { parseWorkXml, buildWorkInboundMessage } = await import("../services/work-wechat/inbound-parser.js");

const TOKEN = "test_work_token_2026";
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 字符占位（不是真实 EncodingAESKey）
const RECEIVE_ID = "wx_test_corp_001";
const fixtureText = readFileSync(resolve(__dirname, "fixtures/work-wechat-text-msg.xml"), "utf8");

describe("work-wechat crypto + parse (B.2)", () => {
  it("AES round-trip: encrypt → decrypt 还原原文", () => {
    const cipher = encrypt(fixtureText, AES_KEY, RECEIVE_ID);
    expect(cipher).toMatch(/^[A-Za-z0-9+/=]+$/);
    const { msg, receiveId } = decrypt(cipher, AES_KEY);
    expect(msg).toBe(fixtureText);
    expect(receiveId).toBe(RECEIVE_ID);
  });

  it("msg_signature pass: sort([token,ts,nonce,encrypt]) → SHA1 命中", () => {
    const ts = "1714694500", nonce = "abc", enc = "ENCBASE64";
    const sig = computeMsgSignature(TOKEN, ts, nonce, enc);
    expect(sig).toBe(computeMsgSignature(TOKEN, ts, nonce, enc));
    expect(sig).toMatch(/^[a-f0-9]{40}$/);
  });
  it("msg_signature fail: token 错 → 不同签名", () => {
    expect(computeMsgSignature(TOKEN, "t", "n", "e")).not.toBe(computeMsgSignature("WRONG", "t", "n", "e"));
  });
  it("msg_signature fail: encrypt 错 → 不同签名", () => {
    expect(computeMsgSignature(TOKEN, "t", "n", "ENC1")).not.toBe(computeMsgSignature(TOKEN, "t", "n", "ENC2"));
  });

  it("解析 external_contact text: parseWorkXml 解出 MsgType=text + Content + AgentID 不强求", () => {
    const p = parseWorkXml(fixtureText);
    expect(p.msgType).toBe("text");
    expect(p.fromUser).toBe("wm_external_test_user_001");
    expect(p.content).toContain("Nature");
  });
  it("解析 kf_msg event 包裹 text: parseWorkXml 携带 Event=kf_msg", () => {
    const xml = `<xml><ToUserName><![CDATA[wx_corp]]></ToUserName><FromUserName><![CDATA[u1]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg]]></Event></xml>`;
    const p = parseWorkXml(xml);
    expect(p.msgType).toBe("event");
    expect(p.event).toBe("kf_msg");
  });
  it("解析 image: buildWorkInboundMessage 返 null（仅 text 入库）", async () => {
    const xml = `<xml><ToUserName><![CDATA[wx_corp]]></ToUserName><FromUserName><![CDATA[u1]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[image]]></MsgType><MsgId>1</MsgId></xml>`;
    const p = parseWorkXml(xml);
    expect(await buildWorkInboundMessage(p)).toBeNull();
  });
});
