/**
 * 微信小程序登录辅助 —— 期刊检索小程序
 *
 * 流程：
 *   小程序 wx.login() → code
 *   小程序 <button open-type="getPhoneNumber"> → phoneCode（新版基础库）或 encryptedData+iv（旧版）
 *   后端：
 *     1) code2session(code) → { openid, session_key }
 *     2) 取手机号：
 *        - 新版：getPhoneNumberByCode(phoneCode)（需 mini access_token）
 *        - 旧版：decryptPhone(encryptedData, iv, session_key)（AES-128-CBC）
 *
 * 需要环境变量：WECHAT_MINI_APPID / WECHAT_MINI_SECRET
 */
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

const WX = "https://api.weixin.qq.com";

export function miniConfigured(): boolean {
  return !!(env.WECHAT_MINI_APPID && env.WECHAT_MINI_SECRET);
}

interface Code2SessionResult {
  openid: string;
  session_key: string;
  unionid?: string;
}

/** code → openid + session_key */
export async function code2Session(code: string): Promise<Code2SessionResult> {
  const url =
    `${WX}/sns/jscode2session?appid=${env.WECHAT_MINI_APPID}` +
    `&secret=${env.WECHAT_MINI_SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = (await resp.json()) as any;
  if (data.errcode) {
    logger.warn({ errcode: data.errcode, errmsg: data.errmsg }, "[mini.code2session.failed]");
    throw new Error(`code2session 失败: ${data.errmsg || data.errcode}`);
  }
  if (!data.openid || !data.session_key) throw new Error("code2session 返回缺少 openid/session_key");
  return { openid: data.openid, session_key: data.session_key, unionid: data.unionid };
}

/** 小程序全局 access_token（简单内存缓存，约 2h 有效，提前 5 min 失效） */
let tokenCache: { token: string; expireAt: number } | null = null;

async function getMiniAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expireAt > Date.now()) return tokenCache.token;
  const url =
    `${WX}/cgi-bin/token?grant_type=client_credential` +
    `&appid=${env.WECHAT_MINI_APPID}&secret=${env.WECHAT_MINI_SECRET}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as any;
  if (!data.access_token) throw new Error(`获取 access_token 失败: ${data.errmsg || "unknown"}`);
  tokenCache = { token: data.access_token, expireAt: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

/** 新版：phoneCode → 手机号 */
export async function getPhoneNumberByCode(phoneCode: string): Promise<string> {
  const accessToken = await getMiniAccessToken();
  const resp = await fetch(`${WX}/wxa/business/getuserphonenumber?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: phoneCode }),
  });
  const data = (await resp.json()) as any;
  if (data.errcode !== 0 || !data.phone_info) {
    throw new Error(`获取手机号失败: ${data.errmsg || data.errcode}`);
  }
  // purePhoneNumber 不带国家码
  return data.phone_info.purePhoneNumber || data.phone_info.phoneNumber;
}

/** 旧版：用 session_key 解密 encryptedData → 手机号 */
export function decryptPhone(encryptedData: string, iv: string, sessionKey: string): string {
  const keyBuf = Buffer.from(sessionKey, "base64");
  const ivBuf = Buffer.from(iv, "base64");
  const dataBuf = Buffer.from(encryptedData, "base64");
  const decipher = crypto.createDecipheriv("aes-128-cbc", keyBuf, ivBuf);
  decipher.setAutoPadding(true);
  let decoded = decipher.update(dataBuf, undefined, "utf8");
  decoded += decipher.final("utf8");
  const parsed = JSON.parse(decoded) as { purePhoneNumber?: string; phoneNumber?: string };
  const phone = parsed.purePhoneNumber || parsed.phoneNumber;
  if (!phone) throw new Error("解密结果缺少手机号");
  return phone;
}
