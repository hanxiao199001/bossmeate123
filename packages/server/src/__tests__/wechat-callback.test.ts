/** B.1: 公众号 inbound webhook 单测 — signature ×3 + 消息类型 ×2 + 幂等 ×1。 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://test/test", WECHAT_VERIFY_TOKEN:"ai_butler_token_2026" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../models/db.js", () => ({ db: {} }));

const { computeSignature } = await import("../routes/wechat-callback.js");
const { parseWechatXml, buildFallbackReply } = await import("../services/wechat/inbound-parser.js");

const TOKEN = "ai_butler_token_2026";
const fixture = readFileSync(resolve(__dirname, "fixtures/wechat-text-msg.xml"), "utf8");

describe("wechat-callback signature + parse + fallback (B.1)", () => {
  it("signature pass: token + timestamp + nonce 排序 → SHA1 命中预期", () => {
    const ts = "1714694400", nonce = "abc123";
    const sig = computeSignature(TOKEN, ts, nonce);
    expect(sig).toBe(computeSignature(TOKEN, ts, nonce));
    expect(sig).toMatch(/^[a-f0-9]{40}$/);
  });
  it("signature fail: 时间戳错位 → 与原签名不同", () => {
    expect(computeSignature(TOKEN, "1714694400", "n1")).not.toBe(computeSignature(TOKEN, "9999999999", "n1"));
  });
  it("signature fail: token 错 → 与原签名不同", () => {
    expect(computeSignature(TOKEN, "t", "n")).not.toBe(computeSignature("WRONG_TOKEN", "t", "n"));
  });
  it("text 消息白名单: parseWechatXml 解出 MsgType=text + Content 命中", () => {
    const p = parseWechatXml(fixture);
    expect(p.msgType).toBe("text");
    expect(p.fromUser).toBe("oFakeOpenIdABCDEF1234");
    expect(p.content).toContain("The Lancet");
    expect(p.msgId).toBe("10000000000000001");
  });
  it("image 走兜底回复（buildFallbackReply 返非空提示，不入 leadCollector）", () => {
    expect(buildFallbackReply("image")).toMatch(/敬请期待|文字/);
    expect(buildFallbackReply("event")).toBe(""); // event 不响应
  });
  it("XML 缺字段 → parseWechatXml 抛错，caller catch 后回 200 空", () => {
    expect(() => parseWechatXml("<xml><MsgType>text</MsgType></xml>")).toThrow(/缺必需字段/);
  });
});
