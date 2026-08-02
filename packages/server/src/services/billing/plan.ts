/**
 * PR-Z4: 套餐与配额 — tenants.config.billing:
 *   { plan: "trial"|"basic"|"pro"|string, expiresAt: "2026-12-31",
 *     monthlyArticleQuota: 300, monthlyVideoQuota: 60, accountLimit: 10 }
 * 未配置 billing = 不限 (向后兼容, 老韩自己的租户不受影响)。
 * 用量口径: 本月该租户 contents 计数 (article/video), 账号数 = platform_accounts 全量。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, platformAccounts, tenants } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export interface BillingPlan {
  plan?: string;
  expiresAt?: string; // YYYY-MM-DD (含当日)
  monthlyArticleQuota?: number;
  monthlyVideoQuota?: number;
  accountLimit?: number;
}

export type BillingAction = "generate_article" | "generate_video" | "add_account";

export interface BillingCheck {
  allowed: boolean;
  reason?: string;
  plan: BillingPlan;
}

export async function readBillingPlan(tenantId: string): Promise<BillingPlan> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const b = (t?.config as { billing?: BillingPlan } | null)?.billing;
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}

/**
 * 8-02: 由 setHours 改为显式北京时区计算(与 cost-ledger 同一处理)。
 * setHours 取的是 Node 进程本地时区, 而 process.env.TZ 未设置 —— 靠服务器 OS 恰好是 CST。
 * 这里管的是**套餐月配额闸**(超了直接拒绝生成), 偏 8 小时会让月初/月末各错一批。
 */
function startOfMonth(): Date {
  const BJ = 8 * 3600_000;
  const bj = new Date(Date.now() + BJ);
  bj.setUTCDate(1);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - BJ);
}

async function monthlyCount(tenantId: string, type: "article" | "video"): Promise<number> {
  const [r] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(contents)
    .where(and(eq(contents.tenantId, tenantId), eq(contents.type, type), gte(contents.createdAt, startOfMonth())));
  return Number(r?.c ?? 0);
}

/** 配额/到期检查。未配置对应项 = 放行。 */
export async function checkBilling(tenantId: string, action: BillingAction): Promise<BillingCheck> {
  const plan = await readBillingPlan(tenantId);
  if (Object.keys(plan).length === 0) return { allowed: true, plan };

  if (plan.expiresAt) {
    const exp = new Date(`${plan.expiresAt}T23:59:59+08:00`);
    if (Number.isFinite(exp.getTime()) && Date.now() > exp.getTime()) {
      return { allowed: false, plan, reason: `套餐已于 ${plan.expiresAt} 到期, 请续费后继续使用` };
    }
  }
  if (action === "generate_article" && plan.monthlyArticleQuota && plan.monthlyArticleQuota > 0) {
    const used = await monthlyCount(tenantId, "article");
    if (used >= plan.monthlyArticleQuota) {
      return { allowed: false, plan, reason: `本月文章生成已达套餐上限 (${used}/${plan.monthlyArticleQuota})` };
    }
  }
  if (action === "generate_video" && plan.monthlyVideoQuota && plan.monthlyVideoQuota > 0) {
    const used = await monthlyCount(tenantId, "video");
    if (used >= plan.monthlyVideoQuota) {
      return { allowed: false, plan, reason: `本月视频生成已达套餐上限 (${used}/${plan.monthlyVideoQuota})` };
    }
  }
  if (action === "add_account" && plan.accountLimit && plan.accountLimit > 0) {
    const [r] = await db.select({ c: sql<string>`COUNT(*)` }).from(platformAccounts).where(eq(platformAccounts.tenantId, tenantId));
    if (Number(r?.c ?? 0) >= plan.accountLimit) {
      return { allowed: false, plan, reason: `账号数已达套餐上限 (${plan.accountLimit} 个)` };
    }
  }
  return { allowed: true, plan };
}

/** 拒绝时统一记日志 (排查"为什么不生成了"用) */
export function logBillingDenied(tenantId: string, action: BillingAction, reason?: string): void {
  logger.warn({ tenantId, action, reason }, "PR-Z4 套餐限制拒绝");
}
