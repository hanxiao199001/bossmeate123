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

/**
 * DVH 成本预估: 3.3 字/秒, 上钳 120 秒。
 *
 * 7-30 去掉 30 秒下限: 阿里云**按真实出片秒数结算, 没有起步价**(实测 54 字稿出片 9.66 秒,
 *   账单 1.59 元 = 9.66 × 0.165)。原来的 `Math.max(30, …)` 会把短稿一律报成 4.95 元,
 *   而实际 1.59 元 —— 差 3 倍, 费用条就失去参考价值了。
 *   下限本是"宁可高报"的保守设计, 但高报 3 倍不叫保守叫失准。
 */
export function estimateDvhCents(narrationText: string): number {
  const seconds = Math.min(120, Math.round(narrationText.length / DVH_CHARS_PER_SECOND));
  return Math.round(seconds * DVH_CENTS_PER_SECOND);
}

/**
 * 口播稿语速基准: 250-350 字 ≈ 90 秒(5 月实测), 即 3.3 字/秒。
 *
 * ⚠️ 7-30 首条真实短稿实测语速是 **5.6 字/秒**(54 字 → 9.66 秒), 比这个基准快得多。
 *   但**一条样本不足以定常数**(语速受标点/数字/英文占比影响), 所以先不动 3.3,
 *   等积累几十条 (contents.metadata.dvhDurationMs 有落库) 再用 p25 校准 ——
 *   取 p25 而不是均值, 是因为预估宁可偏高不可偏低。
 */
export const DVH_CHARS_PER_SECOND = 3.3;

export interface DvhEstimate {
  chars: number;
  seconds: number;
  cents: number;
}

/**
 * 7-30 文字稿直生用的成本预估 —— 与 estimateDvhCents **只差一处: 没有 120 秒上钳**。
 *
 * 为什么必须另开一个而不是直接改 estimateDvhCents:
 *   estimateDvhCents 那个 `Math.min(120, …)` 在文章链路无害 —— videoScript 规格是 220-320 字
 *   (≈90 秒), 永远撞不到钳位。但直生把字数控制权交给了运营, 600 字 ≈ 182 秒:
 *   钳到 120 秒后预估 19.8 元, 而真实账单 30 元 —— **预算闸会漏放 10 元, 前端费用条会少报 10 元**。
 *   一个替运营估钱的数字, 宁可高报不能低报。
 *   而 estimateDvhCents 被文章链路 + 孤儿任务记账共用, 直接改它等于动生产计费口径, 所以另起一个。
 *
 * 7-30 起两者都不再有 30 秒下限(阿里云无起步价, 见 estimateDvhCents 注释)。
 */
export function estimateDvhFromText(narrationText: string): DvhEstimate {
  const chars = String(narrationText ?? "").length;
  // 7-30 同 estimateDvhCents: 去掉 30 秒下限(阿里云按真实秒数结算, 无起步价)
  const seconds = Math.round(chars / DVH_CHARS_PER_SECOND);
  return { chars, seconds, cents: Math.round(seconds * DVH_CENTS_PER_SECOND) };
}
