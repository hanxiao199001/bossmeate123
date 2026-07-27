/**
 * 7-27 无人值守 ③ — LLM 日花费/日调用**硬上限**（平台级熔断）。
 *
 * ============ 为什么必须有这个 ============
 * 老板接下来几个月不看系统。现有两道闸都**盖不住无人值守下的烧钱事故**：
 *   - `checkBudget`(cost-ledger) 是**租户级预算**，且只有配了 budgetConfig 的租户才生效，
 *     默认不限；而且它只在**花钱前显式调用它的地方**才拦（目前只有数字人合成 article-bridge 调）。
 *   - LLM 调用链路（chat → recordLlmUsage）**只记账、不设闸** —— 一个重试死循环 bug
 *     能在一夜之间把阿里云余额刷空，第二天简报才报出来，人却在度假。
 *
 * 余额烧光 = **更长时间的停产**（充值要走财务、可能几天），所以取舍很明确：
 *   **宁可今天不生产，也不能把余额烧光。** 触顶就停生成、落告警、等第二天自动解封。
 *
 * ============ 设计 ============
 * - **平台级、不分租户**：烧的是同一个阿里云账户余额，按租户分摊反而拦不住单点失控。
 * - **真相源 = cost_ledger**（kind='llm'，按北京时间日切）。不靠进程内计数当权威 ——
 *   服务重启、多进程 worker 都会让内存计数失真。DB 是唯一账本。
 * - **60s 缓存 + 进程内增量**：每次 LLM 调用都查库不现实；缓存窗口内用 `noteLlmSpend()`
 *   把刚花的钱累加到本地副本上，所以窗口内也能及时触顶（宁可早停一点）。
 * - **失败开放（fail-open）**：查不到账本（DB 抖动）时放行。理由：这道闸是防"异常烧钱"的，
 *   不是权限闸；让 DB 抖动直接停掉全系统生产，是拿一个小故障换一个大故障。
 *   真 DB 挂了 `/health/ping` 会 503，外部拨测会喊。
 * - **判定纯函数 `judgeLlmCap` 无 IO**，单测直接锁行为。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { costLedger } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { startOfBjDay } from "../metrics/matrix-health.js";

/** 触顶事件的 incident kind（简报里红色置顶）。用字符串常量，避免与并行改 incidents.ts 的人撞车。 */
export const LLM_CAP_INCIDENT_KIND = "llm_cost_cap";

export interface LlmCapConfig {
  /** 日花费上限（元）。0 = 不限 */
  dailyCostCapYuan: number;
  /** 日调用次数上限。0 = 不限 */
  dailyCallCap: number;
  /** 总开关 */
  enabled: boolean;
}

export interface LlmDailyUsage {
  costCents: number;
  calls: number;
}

export interface LlmCapVerdict {
  allowed: boolean;
  /** 触顶原因（人话，直接进简报/日志） */
  reason: string | null;
  /** 已用掉上限的百分比（两项取高者），无上限时为 null */
  usedPct: number | null;
}

/** 从 env 取当前配置（每次读，方便改 .env 重启即生效；不缓存避免测试串味） */
export function getLlmCapConfig(): LlmCapConfig {
  return {
    dailyCostCapYuan: env.LLM_DAILY_COST_CAP_YUAN,
    dailyCallCap: env.LLM_DAILY_CALL_CAP,
    enabled: env.LLM_DAILY_CAP_ENABLED,
  };
}

/**
 * 判定纯函数：今日用量 + 配置 → 放行/熔断。
 * 上限设 0 = 该项不限；两项都不限或总开关关 = 永远放行。
 */
export function judgeLlmCap(usage: LlmDailyUsage, cfg: LlmCapConfig): LlmCapVerdict {
  if (!cfg.enabled) return { allowed: true, reason: null, usedPct: null };

  const costCapCents = cfg.dailyCostCapYuan > 0 ? Math.round(cfg.dailyCostCapYuan * 100) : 0;
  const callCap = cfg.dailyCallCap > 0 ? Math.floor(cfg.dailyCallCap) : 0;
  if (costCapCents <= 0 && callCap <= 0) return { allowed: true, reason: null, usedPct: null };

  const pcts: number[] = [];
  if (costCapCents > 0) pcts.push(Math.round((usage.costCents / costCapCents) * 100));
  if (callCap > 0) pcts.push(Math.round((usage.calls / callCap) * 100));
  const usedPct = pcts.length ? Math.max(...pcts) : null;

  if (costCapCents > 0 && usage.costCents >= costCapCents) {
    return {
      allowed: false,
      usedPct,
      reason:
        `今日 AI 调用已花 ${(usage.costCents / 100).toFixed(2)} 元, 触达日花费硬上限 ${cfg.dailyCostCapYuan} 元 —— ` +
        `已停止内容生成(明天北京时间零点自动解封)。这是防"程序 bug 疯狂重试把余额烧光"的保险: ` +
        `余额烧光=停产好几天, 今天少产一批=停产一天, 两害取轻。确认是正常放量请调高 LLM_DAILY_COST_CAP_YUAN。`,
    };
  }
  if (callCap > 0 && usage.calls >= callCap) {
    return {
      allowed: false,
      usedPct,
      reason:
        `今日 AI 调用已达 ${usage.calls} 次, 触达日调用硬上限 ${cfg.dailyCallCap} 次 —— 已停止内容生成` +
        `(明天北京时间零点自动解封)。次数暴涨而花费不高, 典型是**失败重试打转**, 请查服务器日志里的超时/报错。`,
    };
  }
  return { allowed: true, reason: null, usedPct };
}

// ============ 用量读取（cost_ledger 是唯一账本） ============

/** 今日（北京时间）全平台 LLM 花费与调用次数。 */
export async function getLlmDailyUsage(now: Date = new Date()): Promise<LlmDailyUsage> {
  const since = startOfBjDay(now);
  const [row] = await db
    .select({
      cents: sql<string>`COALESCE(SUM(${costLedger.amountCents}), 0)`,
      calls: sql<string>`COUNT(*)`,
    })
    .from(costLedger)
    .where(and(eq(costLedger.kind, "llm"), gte(costLedger.createdAt, since)));
  return { costCents: Number(row?.cents ?? 0), calls: Number(row?.calls ?? 0) };
}

// ============ 带缓存的闸门 ============

/** 账本查询缓存窗口。60s：足够挡住"每次调用查一次库"，又不至于让触顶延迟到有意义的程度。 */
export const LLM_CAP_CACHE_MS = 60_000;

interface CacheState {
  at: number;
  /** 库里读到的基线 */
  base: LlmDailyUsage;
  /** 缓存窗口内本进程又花掉的（noteLlmSpend 累加），避免窗口内失明 */
  delta: LlmDailyUsage;
  /** 缓存对应的北京日期，跨天自动作废 */
  bjDate: string;
}

let cache: CacheState | null = null;
/** 今天是否已经就"触顶"落过一次告警（同一天只喊一次，别把 ops_incidents 刷屏） */
let alertedForDate: string | null = null;

function bjDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 仅供单测：清空缓存与告警去重状态 */
export function __resetLlmGuard(): void {
  cache = null;
  alertedForDate = null;
}

/**
 * 记一笔刚发生的 LLM 花费到进程内增量上（recordLlmUsage 出口调用）。
 * 只影响缓存窗口内的判定精度，不改变账本 —— 账本永远以 cost_ledger 为准。
 */
export function noteLlmSpend(cents: number, now: Date = new Date()): void {
  if (!cache || cache.bjDate !== bjDate(now)) return; // 没缓存 / 跨天了：下次查库自然会读到
  cache.delta.costCents += Math.max(0, cents);
  cache.delta.calls += 1;
}

/**
 * 闸门：现在还能不能调 LLM / 继续生成。
 * 生成链路在**每篇内容开工前**调一次即可（见 recommendation/daily-cron.ts）。
 */
export async function checkLlmDailyCap(now: Date = new Date()): Promise<LlmCapVerdict & { usage: LlmDailyUsage }> {
  const cfg = getLlmCapConfig();
  const today = bjDate(now);

  if (!cfg.enabled || (cfg.dailyCostCapYuan <= 0 && cfg.dailyCallCap <= 0)) {
    return { allowed: true, reason: null, usedPct: null, usage: { costCents: 0, calls: 0 } };
  }

  if (!cache || cache.bjDate !== today || now.getTime() - cache.at > LLM_CAP_CACHE_MS) {
    try {
      const base = await getLlmDailyUsage(now);
      cache = { at: now.getTime(), base, delta: { costCents: 0, calls: 0 }, bjDate: today };
    } catch (err) {
      // fail-open：账本读不出来不代表在烧钱，别拿小故障换大故障
      logger.warn({ err: err instanceof Error ? err.message : err }, "llm_guard.usage_read_failed — 本次放行(fail-open)");
      return { allowed: true, reason: null, usedPct: null, usage: { costCents: 0, calls: 0 } };
    }
  }

  const usage: LlmDailyUsage = {
    costCents: cache.base.costCents + cache.delta.costCents,
    calls: cache.base.calls + cache.delta.calls,
  };
  const verdict = judgeLlmCap(usage, cfg);

  if (!verdict.allowed && alertedForDate !== today) {
    alertedForDate = today;
    logger.error({ usage, cfg }, "🛑 LLM 日上限熔断 — 已停止生成(宁可停产不烧余额)");
    // 告警旁路：recordIncident 自身绝不抛错
    const { recordIncident } = await import("../ops/incidents.js");
    await recordIncident({
      kind: LLM_CAP_INCIDENT_KIND,
      severity: "error",
      message: verdict.reason ?? "LLM 日上限熔断",
      detail: { usage, cap: { yuan: cfg.dailyCostCapYuan, calls: cfg.dailyCallCap }, date: today },
    });
  }

  return { ...verdict, usage };
}
