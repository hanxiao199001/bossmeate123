/**
 * Hard guard —— ConversationAgent 主路径前置硬规则。
 *
 * 命中 4 类高风险词 → 跳过 LLM，发罐头消息 + 切真人接管。
 * 命中 tenant whitelist → 视为已澄清场景，正常走 LLM。
 *
 * 4 类设计依据（设计文档 D1）：
 *   quote     报价/费用类（AI 给死价 = 法律/合规风险）
 *   contract  合同/盖章类（AI 不能签）
 *   legal     担保/包过/退款类（监管红线）
 *   deadline  确切时效承诺类（AI 不能保证审稿周期）
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { hardGuardWhitelist } from "../../models/schema.js";

export type HardGuardCategory = "quote" | "contract" | "legal" | "deadline";

export const HARD_GUARD_PATTERNS: Record<HardGuardCategory, RegExp> = {
  quote:    /(多少钱|什么价位|价格|报价|费用|开票|多少\s*RMB|多少\s*美元|多少\s*USD)/,
  contract: /(合同|协议|甲乙双方|签约|盖章|法人代表)/,
  legal:    /(包过|包录|100%|担保|赔偿|退款)/,
  deadline: /(几天|多久|什么时候).{0,15}(出刊|发表|录用|拿到)/,
};

/**
 * B.6 双轨罐头：hard guard 命中时既切真人接管，又同步推 BossMate 平台 URL（自服务漏斗入口）。
 * URL 占位符在 caller 层用 tenants.bossmate_platform_url 替换；fallback 在 conversation-agent 内做。
 */
export const CANNED_REPLY_TEMPLATE =
  "您好我是 BossMate 客服小王 ☕ 您稍等，我马上让对接老师联系您。\n同时您可以打开我们 BossMate 平台 {bossmate_url}，AI 3 秒匹配 5 本最对口期刊，免费试用~";

export function buildCannedReply(bossmateUrl: string): string {
  return CANNED_REPLY_TEMPLATE.replace("{bossmate_url}", bossmateUrl);
}

export interface HardGuardResult {
  hit: boolean;
  category?: HardGuardCategory;
  whitelisted: boolean;
}

const WHITELIST_TTL_MS = 60_000;
let whitelistCache: { tenantId: string; patterns: string[]; loadedAt: number } | null = null;

async function loadWhitelist(tenantId: string): Promise<string[]> {
  const now = Date.now();
  if (whitelistCache && whitelistCache.tenantId === tenantId && now - whitelistCache.loadedAt < WHITELIST_TTL_MS) {
    return whitelistCache.patterns;
  }
  const rows = await db
    .select({ pattern: hardGuardWhitelist.pattern })
    .from(hardGuardWhitelist)
    .where(eq(hardGuardWhitelist.tenantId, tenantId));
  const patterns = rows.map((r) => r.pattern);
  whitelistCache = { tenantId, patterns, loadedAt: now };
  return patterns;
}

/** 测试 / tenant 切换时清缓存。 */
export function clearWhitelistCache(): void {
  whitelistCache = null;
}

/**
 * 检测客户消息是否命中 hard guard。
 *   1. 先 whitelist 命中 → return { hit:false, whitelisted:true }（让 LLM 走）
 *   2. 再 4 类 regex 匹配 → 命中 return { hit:true, category }
 *   3. 都不命中 → return { hit:false, whitelisted:false }
 */
export async function hardGuardCheck(text: string, tenantId: string): Promise<HardGuardResult> {
  const wl = await loadWhitelist(tenantId);
  for (const p of wl) {
    if (text.includes(p)) return { hit: false, whitelisted: true };
  }
  for (const [cat, regex] of Object.entries(HARD_GUARD_PATTERNS) as [HardGuardCategory, RegExp][]) {
    if (regex.test(text)) return { hit: true, category: cat, whitelisted: false };
  }
  return { hit: false, whitelisted: false };
}
