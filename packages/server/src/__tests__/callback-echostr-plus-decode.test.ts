/**
 * 7-06 回调 echostr '+' 还原修复。
 * 查询串里 base64 echostr 的 '+' 被 URL 解码成空格 → 企微回调签名算错(mismatch)+解密炸。
 * 修复: GET handler 在签名/解密前 echostr.replace(/ /g, "+")。本测试锁"带空格也能过"。
 */
import { describe, it, expect } from "vitest";
import { computeMsgSignature, encrypt, decrypt } from "../services/work-wechat/crypto.js";

const AESKEY = "a".repeat(43); // 43 字符 → getAesKey 补 '=' 到 44 → 解码 32 字节, 合法
const RECEIVE = "ww7416fba58ee8a96a";
const TOKEN = "tHnn6Iw7R3qf8qGgp5CIUYsBq8";
const TS = "1700000000";
const NONCE = "abc123nonce";

describe("回调 echostr '+' 还原 (7-06 企微 handshake 修复)", () => {
  it("含 '+' 的密文 echostr, URL 解码成空格后, 还原能通过签名 + 解密", () => {
    // 造一个真实密文 echostr, 保证命中含 '+' 的情况
    let echostr = "", plain = "";
    for (let i = 0; i < 80 && !echostr.includes("+"); i++) {
      plain = "hello-echo-" + i;
      echostr = encrypt(plain, AESKEY, RECEIVE);
    }
    expect(echostr).toContain("+"); // 确认测到 '+' 场景

    const correctSig = computeMsgSignature(TOKEN, TS, NONCE, echostr);

    // 模拟 fastify 把查询串里的 '+' 解成空格
    const corrupted = echostr.replace(/\+/g, " ");
    expect(corrupted).not.toContain("+");
    // 未修复: 直接用 corrupted → 签名对不上(实锤 bug)
    expect(computeMsgSignature(TOKEN, TS, NONCE, corrupted)).not.toBe(correctSig);

    // 修复: 还原 '+'
    const restored = corrupted.replace(/ /g, "+");
    expect(restored).toBe(echostr);
    // 还原后: 签名对得上 + 解密拿回原文
    expect(computeMsgSignature(TOKEN, TS, NONCE, restored)).toBe(correctSig);
    expect(decrypt(restored, AESKEY).msg).toBe(plain);
  });

  it("未损坏(无空格)的 echostr 还原是 no-op", () => {
    const s = "abcDEF123xyz";
    expect(s.replace(/ /g, "+")).toBe(s);
  });
});
