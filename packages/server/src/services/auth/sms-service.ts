/**
 * 6-20 Phase2 手机验证码服务。安全三件套(防刷/防爆破/一码一用)是必需项, 不是可选:
 *   ① 限频: 同手机号 60s 内只能发 1 条, 1 小时内最多 5 条 (防短信轰炸 + 烧短信费)。
 *   ② 防爆破: 校验错误累计 attemptCount, 超 MAX_ATTEMPTS 锁定该码 (须重新获取)。
 *   ③ 一码一用: 校验成功即置 consumedAt; 只取最新一条未消费未过期的码。
 *
 * 发送通道可插拔: 配了阿里云短信(SMS_PROVIDER=aliyun + 签名/模板 + ALIYUN key)就走阿里云;
 *   否则 dev 模式 —— 不真发, 把验证码放日志 + 接口响应(devCode)里, 方便本地/联调测试。
 *   ⚠ devCode 仅在非 production 返回, 绝不在生产泄露验证码。
 */
import bcrypt from "bcrypt";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "../../models/db.js";
import { smsCodes } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

const CODE_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟有效
const RESEND_COOLDOWN_MS = 60 * 1000; // 同号 60s 冷却
const HOURLY_LIMIT = 5; // 同号每小时最多 5 条
const MAX_ATTEMPTS = 5; // 单码最多校验 5 次

export type SmsPurpose = "login" | "register" | "invite";

export interface SendResult {
  sent: boolean;
  devCode?: string; // 仅非 production 返回, 供联调
  cooldownMs?: number;
}

const PHONE_RE = /^1[3-9]\d{9}$/;
export function isValidPhone(phone: string): boolean {
  return PHONE_RE.test(phone);
}

/** 发送验证码: 限频 → 生成 6 位 → 存 hash → 发送(阿里云或 dev)。 */
export async function sendSmsCode(phone: string, purpose: SmsPurpose, ip?: string): Promise<SendResult> {
  if (!isValidPhone(phone)) throw new SmsError("INVALID_PHONE", "手机号格式不正确");

  // ① 限频
  const now = Date.now();
  const recent = await db
    .select({ createdAt: smsCodes.createdAt })
    .from(smsCodes)
    .where(and(eq(smsCodes.phone, phone), gte(smsCodes.createdAt, new Date(now - 60 * 60 * 1000))))
    .orderBy(desc(smsCodes.createdAt));
  if (recent.length >= HOURLY_LIMIT) throw new SmsError("RATE_LIMITED", "今日获取过于频繁, 请稍后再试");
  if (recent[0] && now - new Date(recent[0].createdAt).getTime() < RESEND_COOLDOWN_MS) {
    const cooldownMs = RESEND_COOLDOWN_MS - (now - new Date(recent[0].createdAt).getTime());
    throw new SmsError("COOLDOWN", `请 ${Math.ceil(cooldownMs / 1000)} 秒后再获取`);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 位
  const codeHash = await bcrypt.hash(code, 10);
  await db.insert(smsCodes).values({
    phone,
    codeHash,
    purpose,
    ip: ip ?? null,
    expiresAt: new Date(now + CODE_TTL_MS),
  });

  const isProd = env.NODE_ENV === "production";
  const provider = (process.env.SMS_PROVIDER || "").toLowerCase();
  if (provider === "aliyun") {
    await sendViaAliyun(phone, code);
    return { sent: true };
  }
  // dev: 不真发, 回传 devCode 便于联调
  logger.warn({ phone, code, purpose }, "📩 [DEV] 短信未配置真实通道, 验证码见此日志");
  return { sent: true, devCode: isProd ? undefined : code };
}

/** 校验验证码: 取最新未消费未过期码 → 锁定检查 → 比对 → 成功置 consumed。 */
export async function verifySmsCode(phone: string, code: string, purpose: SmsPurpose): Promise<boolean> {
  const [row] = await db
    .select()
    .from(smsCodes)
    .where(and(
      eq(smsCodes.phone, phone),
      eq(smsCodes.purpose, purpose),
      isNull(smsCodes.consumedAt),
      gte(smsCodes.expiresAt, new Date()),
    ))
    .orderBy(desc(smsCodes.createdAt))
    .limit(1);

  if (!row) throw new SmsError("CODE_EXPIRED", "验证码已过期或不存在, 请重新获取");
  if ((row.attemptCount ?? 0) >= MAX_ATTEMPTS) throw new SmsError("CODE_LOCKED", "尝试次数过多, 请重新获取验证码");

  const ok = await bcrypt.compare(code, row.codeHash);
  if (!ok) {
    await db.update(smsCodes).set({ attemptCount: (row.attemptCount ?? 0) + 1 }).where(eq(smsCodes.id, row.id));
    throw new SmsError("CODE_WRONG", "验证码错误");
  }
  await db.update(smsCodes).set({ consumedAt: new Date() }).where(eq(smsCodes.id, row.id)); // 一码一用
  return true;
}

/** 阿里云短信发送(可选)。需 @alicloud/dysmsapi20170525 + SMS_SIGN_NAME + SMS_TEMPLATE_CODE + ALIYUN key。 */
async function sendViaAliyun(phone: string, code: string): Promise<void> {
  const templateCode = process.env.SMS_TEMPLATE_CODE;
  if (!templateCode) throw new SmsError("SMS_NOT_CONFIGURED", "阿里云短信未配置(缺 SMS_TEMPLATE_CODE)");
  await sendViaAliyunTemplate(phone, templateCode, { code });
}

/** 7-05 通用阿里云模板短信(验证码/欢迎短信共用)。 */
async function sendViaAliyunTemplate(phone: string, templateCode: string, templateParam: Record<string, string>): Promise<void> {
  const signName = process.env.SMS_SIGN_NAME;
  const akId = env.ALIYUN_ACCESS_KEY_ID || env.ALIYUN_AK_ID;
  const akSecret = env.ALIYUN_ACCESS_KEY_SECRET || env.ALIYUN_AK_SECRET;
  if (!signName || !akId || !akSecret) {
    throw new SmsError("SMS_NOT_CONFIGURED", "阿里云短信未配置(签名/AccessKey 缺失)");
  }
  try {
    // 动态导入: 未装 SDK 时给出明确指引, 不让整个服务编译期硬依赖。
    // 变量化 specifier: 未装 SDK 时不让 TS 在编译期硬解析模块
    const dysmsPkg = "@alicloud/dysmsapi20170525", utilPkg = "@alicloud/tea-util", openapiPkg = "@alicloud/openapi-client";
    const mod: any = await import(dysmsPkg).catch(() => null);
    const Util: any = await import(utilPkg).catch(() => null);
    const OpenApi: any = await import(openapiPkg).catch(() => null);
    if (!mod || !OpenApi) throw new SmsError("SMS_SDK_MISSING", "未安装阿里云短信 SDK: pnpm add @alicloud/dysmsapi20170525 @alicloud/openapi-client @alicloud/tea-util");
    const Dysms = mod.default ?? mod;
    const Config = (OpenApi.default ?? OpenApi).Config;
    const client = new Dysms(new Config({ accessKeyId: akId, accessKeySecret: akSecret, endpoint: "dysmsapi.aliyuncs.com" }));
    const Req = (mod.SendSmsRequest ?? Dysms.SendSmsRequest);
    const req = new Req({ phoneNumbers: phone, signName, templateCode, templateParam: JSON.stringify(templateParam) });
    const runtime = Util ? new (Util.default ?? Util).RuntimeOptions({}) : undefined;
    const resp = await client.sendSmsWithOptions(req, runtime);
    const body = resp?.body;
    if (body?.code !== "OK") throw new SmsError("SMS_SEND_FAILED", `短信发送失败: ${body?.message || body?.code}`);
    logger.info({ phone }, "阿里云短信已发送");
  } catch (err) {
    if (err instanceof SmsError) throw err;
    logger.error({ err: String(err), phone }, "阿里云短信发送异常");
    throw new SmsError("SMS_SEND_FAILED", "短信发送失败, 请稍后重试");
  }
}

/**
 * 7-05 多租户开通 P0: 开通成功后的欢迎短信("您的 BossMate 已开通, 用本手机号验证码登录: <域名>")。
 * 优雅降级: 短信通道/欢迎模板未配置(SMS_PROVIDER != aliyun 或缺 SMS_WELCOME_TEMPLATE_CODE)
 *   或发送失败 → 不抛错, 返回 { sent: false, reason }, 由调用方在响应里提示"请口头通知客户"。
 * 阿里云欢迎模板变量约定: { company } (如"${company}的 BossMate 已开通...")。
 */
export async function sendWelcomeSms(phone: string, params: Record<string, string>): Promise<{ sent: boolean; reason?: string }> {
  if (!isValidPhone(phone)) return { sent: false, reason: "手机号格式不正确" };
  const provider = (process.env.SMS_PROVIDER || "").toLowerCase();
  if (provider !== "aliyun") return { sent: false, reason: "短信通道未配置(SMS_PROVIDER)" };
  const templateCode = process.env.SMS_WELCOME_TEMPLATE_CODE;
  if (!templateCode) return { sent: false, reason: "欢迎短信模板未配置(SMS_WELCOME_TEMPLATE_CODE)" };
  try {
    await sendViaAliyunTemplate(phone, templateCode, params);
    logger.info({ phone }, "欢迎短信已发送");
    return { sent: true };
  } catch (err) {
    logger.warn({ err: String(err), phone }, "欢迎短信发送失败(不阻塞开通)");
    return { sent: false, reason: err instanceof SmsError ? err.message : "短信发送失败" };
  }
}

export class SmsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "SmsError";
  }
}
