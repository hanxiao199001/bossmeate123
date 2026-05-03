/**
 * 企业微信回调加解密 — B.2
 *
 * 文档参照：https://developer.work.weixin.qq.com/document/path/90968 (官方 GenericC++ 算法)
 *
 * 关键点：
 *   - msg_signature = SHA1(sort([token, timestamp, nonce, encrypt]).join(''))
 *     **必须排序**（4 字符串字典序），坊间博客说"不排序"是 bug。
 *   - EncodingAESKey 是 43 字符 base64，**追加 "=" 填充到 44** 后 base64 decode 得到 32 字节 AES key
 *   - 全文 AES-256-CBC，IV = AES key 的前 16 字节
 *   - 明文格式：random(16) + msg_len(4 bytes BE) + msg + receiveid（PKCS7 padding）
 *   - msg_len 是 32-bit 大端整数；receiveid 一般是 corpId
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 企微回调 4 参数签名（**字典序排序**）。 */
export function computeMsgSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

function getAesKey(encodingAesKey: string): Buffer {
  // 43 字符 + '=' = 44 字符 → base64 decode = 32 字节
  const padded = encodingAesKey.length === 43 ? encodingAesKey + "=" : encodingAesKey;
  const key = Buffer.from(padded, "base64");
  if (key.length !== 32) throw new Error(`encodingAesKey 解码后长度 ${key.length} ≠ 32`);
  return key;
}

/** 解密企微 <Encrypt> 字段密文（base64） → 明文 XML。返 { msg, receiveId }。 */
export function decrypt(encrypt: string, encodingAesKey: string): { msg: string; receiveId: string } {
  const key = getAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const cipher = Buffer.from(encrypt, "base64");
  const dec = createDecipheriv("aes-256-cbc", key, iv);
  dec.setAutoPadding(false); // PKCS7 手动剥
  const buf = Buffer.concat([dec.update(cipher), dec.final()]);
  // 剥 PKCS7 padding
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) throw new Error(`PKCS7 padding 非法 ${pad}`);
  const unpadded = buf.subarray(0, buf.length - pad);
  // 跳过 16 字节 random，读 4 字节 msg_len（BE）
  if (unpadded.length < 20) throw new Error("解密结果过短");
  const msgLen = unpadded.readUInt32BE(16);
  if (msgLen <= 0 || 20 + msgLen > unpadded.length) throw new Error(`msgLen ${msgLen} 越界`);
  const msg = unpadded.subarray(20, 20 + msgLen).toString("utf8");
  const receiveId = unpadded.subarray(20 + msgLen).toString("utf8");
  return { msg, receiveId };
}

/** 加密明文 XML → base64 密文（仅测试 / 未来 outbound 用，本 PR 主要为 fixture 重新加密）。 */
export function encrypt(msg: string, encodingAesKey: string, receiveId: string): string {
  const key = getAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random = randomBytes(16);
  const msgBuf = Buffer.from(msg, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const receiveIdBuf = Buffer.from(receiveId, "utf8");
  const plain = Buffer.concat([random, lenBuf, msgBuf, receiveIdBuf]);
  // PKCS7 padding 到 32 倍数
  const padLen = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const c = createCipheriv("aes-256-cbc", key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString("base64");
}
