/**
 * PR-W1: 成本台账 + 预算闸。
 * - recordCost: 每笔真实扣费记一行 (绝不抛错 — 记账失败不能搞挂业务, 只 ERROR 日志)。
 * - getSpend: 今日/本月已花 (分)。
 * - checkBudget: 预算闸 — tenants.config.budgetConfig { dailyLimitYuan, monthlyLimitYuan }
 *   未配置 = 不限 (向后兼容); 超限返回 allowed=false, 调用方拒绝执行花钱动作。
 * DVH 计价: 0.165 元/秒 = 16.5 分/秒 (5月实测)。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { costLedger, tenants } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export const DVH_CENTS_PER_SECOND = 16.5;

export type CostKind = "dvh" | "tts" | "render" | "llm";

export interface RecordCostInput {
  tenantId: string;
  kind: CostKind;
  amountCents: number;
  contentId?: string | null;
  quantity?: number | null; // dvh=秒
  note?: string;
}

/** 记一笔扣费。绝不抛错。 */
export async function recordCost(input: RecordCostInput): Promise<void> {
  try {
    await db.insert(costLedger).values({
      tenantId: input.tenantId,
      kind: input.kind,
      amountCents: Math.max(0, Math.round(input.amountCents)),
      contentId: input.contentId ?? null,
      quantity: input.quantity != null ? Math.round(input.quantity) : null,
      note: input.note?.slice(0, 300) ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: msg, ...input },
      "cost_ledger.record_failed — 扣费已发生但没记上账, 需人工核对",
    );
    // 7-25 运维告警: 此前记账失败只有这条日志(没人天天看)。落 ops_incidents → 进每日简报。
    // recordIncident 自身绝不抛错; DB 整个不通时它也只会再记一条日志, 不会让 recordCost 破功。
    const { recordIncident } = await import("../ops/incidents.js");
    await recordIncident({
      kind: "ledger_write_failed",
      tenantId: input.tenantId,
      message: `扣费 ${(input.amountCents / 100).toFixed(2)} 元(${input.kind})未记上账: ${msg}`,
      detail: { kind: input.kind, amountCents: input.amountCents, contentId: input.contentId ?? null },
    });
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface SpendSummary {
  todayCents: number;
  monthCents: number;
}

export async function getSpend(tenantId: string): Promise<SpendSummary> {
  const sum = async (since: Date): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`COALESCE(SUM(${costLedger.amountCents}), 0)` })
      .from(costLedger)
      .where(and(eq(costLedger.tenantId, tenantId), gte(costLedger.createdAt, since)));
    return Number(row?.total ?? 0);
  };
  return { todayCents: await sum(startOfToday()), monthCents: await sum(startOfMonth()) };
}

export interface BudgetConfig {
  dailyLimitYuan?: number;
  monthlyLimitYuan?: number;
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  spend: SpendSummary;
  budget: BudgetConfig;
}

/** 预算闸: 即将花 estimateCents 时检查日/月上限。未配置预算 = 放行。 */
export async function checkBudget(tenantId: string, estimateCents: number): Promise<BudgetCheck> {
  let budget: BudgetConfig = {};
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const raw = (t?.config as { budgetConfig?: BudgetConfig } | null)?.budgetConfig;
    if (raw && typeof raw === "object") {
      budget = {
        dailyLimitYuan: Number(raw.dailyLimitYuan) > 0 ? Number(raw.dailyLimitYuan) : undefined,
        monthlyLimitYuan: Number(raw.monthlyLimitYuan) > 0 ? Number(raw.monthlyLimitYuan) : undefined,
      };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, tenantId }, "budget.config_read_failed — 放行");
  }
  const spend = await getSpend(tenantId);
  if (budget.dailyLimitYuan && spend.todayCents + estimateCents > budget.dailyLimitYuan * 100) {
    return {
      allowed: false, spend, budget,
      reason: `今日已消耗 ${(spend.todayCents / 100).toFixed(2)} 元, 本次预估 ${(estimateCents / 100).toFixed(2)} 元, 将超过每日预算 ${budget.dailyLimitYuan} 元`,
    };
  }
  if (budget.monthlyLimitYuan && spend.monthCents + estimateCents > budget.monthlyLimitYuan * 100) {
    return {
      allowed: false, spend, budget,
      reason: `本月已消耗 ${(spend.monthCents / 100).toFixed(2)} 元, 本次预估 ${(estimateCents / 100).toFixed(2)} 元, 将超过每月预算 ${budget.monthlyLimitYuan} 元`,
    };
  }
  return { allowed: true, spend, budget };
}

/** DVH 成本预估: 250-350字≈90秒 (3.3字/秒), 钳在 30~120 秒。 */
export function estimateDvhCents(narrationText: string): number {
  const seconds = Math.min(120, Math.max(30, Math.round(narrationText.length / 3.3)));
  return Math.round(seconds * DVH_CENTS_PER_SECOND);
}
