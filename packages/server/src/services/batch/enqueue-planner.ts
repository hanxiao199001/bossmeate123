/**
 * 8-02 批量入队的**日配额分片**。
 *
 * 【为什么有这个文件】2026-08-01 事故复盘:
 *   行业月度 cron 在 BJ 00:00~00:03 一次性入队 **593 行**(4 行业 × 3 租户 × ~50),
 *   而平时一天只有 24 行。每篇文章实测要 **8~10 次** LLM 调用(生成 + 六维质检 + 压缩 +
 *   去 AI 腔 + 重写 + 合规…), 日调用硬上限 2000 次 → 天花板约 **222 篇/天**。
 *   593 篇是天花板的 2.7 倍, **必然撞顶**: 第一个租户 199 行跑完就把配额烧光,
 *   后两个租户 394 行全部作废(且当时是永久 failed, 不是推迟 —— 见 batch-worker 的推迟改造)。
 *   这是**月度**任务, 不修下个月一定重演。
 *
 * 【判断依据(留档, 免得下次又从头查)】那天不是"失败重试打转":
 *   - 每次调用均价 0.0195 元, 与近邻日 0.0177~0.0194 持平(重试打转会是大量廉价失败调用)
 *   - 8 条 llm_timeout 全部 suppressedSinceLastAlert=0, 说明超时稀疏(当天仅 5 次)
 *   - 2038 次 / 219 篇 = 9.3 次/篇, 与正常日 8.1~8.3 次/篇 同量级
 *   → 那 2038 次是**真实成功调用**, 病在入队量, 不在重试。
 *
 * 【设计: (c) 主 + (b) 兜底】
 *   (c) 入队前用**真实剩余配额**算今天能跑多少行;
 *   (b) 超出的部分不丢弃, 用 BullMQ `delay` 顺延到后面几天(BullMQ 自己在 Redis 持久化
 *       delayed job, 不需要我们新增任何跨天调度状态)。
 *   没选"按天花板硬编码分片": 每篇调用数会随 prompt 改动漂移, 写死的系数迟早失真。
 */
import { and, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, costLedger } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

/** 系数兜底范围。实测 8~10, 给足余量防止某天数据异常把分片算炸 */
export const CALLS_PER_ARTICLE_MIN = 3;
export const CALLS_PER_ARTICLE_MAX = 30;
/** 取不到数据时的保守默认(宁可高估 → 少排一点, 也不要低估 → 又撞顶) */
export const CALLS_PER_ARTICLE_FALLBACK = 12;
/**
 * 只用剩余配额的这个比例来排产。
 * 留 20% 给**不走 batch 的消耗**: AI 客服对话、数字人文案、admin 手动生成、
 * 以及每篇调用数本身的波动。撞顶的代价(整批作废/顺延一天)远大于少排几篇。
 */
export const CAPACITY_SAFETY_RATIO = 0.8;

/**
 * 近 7 日实测「每篇文章消耗多少次 LLM 调用」。
 * 分子 = cost_ledger 里 kind='llm' 的**行数**(与 llm-guard 的日调用计数同源, 口径必须一致);
 * 分母 = 同窗口 contents 条数。
 * 任何异常都退回保守默认, 绝不抛 —— 这条链路挂了不能反过来把排产搞挂。
 */
export async function estimateCallsPerArticle(): Promise<number> {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [callRow] = await db
      .select({ n: sql<string>`COUNT(*)` })
      .from(costLedger)
      .where(and(gte(costLedger.createdAt, since), sql`${costLedger.kind} = 'llm'`));
    const [artRow] = await db
      .select({ n: sql<string>`COUNT(*)` })
      .from(contents)
      .where(gte(contents.createdAt, since));
    const calls = Number(callRow?.n ?? 0);
    const arts = Number(artRow?.n ?? 0);
    if (arts <= 0 || calls <= 0) return CALLS_PER_ARTICLE_FALLBACK;
    const raw = calls / arts;
    return Math.min(CALLS_PER_ARTICLE_MAX, Math.max(CALLS_PER_ARTICLE_MIN, raw));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "分片: 每篇调用数估算失败, 用保守默认");
    return CALLS_PER_ARTICLE_FALLBACK;
  }
}

/**
 * 纯函数: 今天还能排几行。无 IO, 直接单测。
 * @param callCap        日调用硬上限(0 = 不限)
 * @param usedCalls      今日已用调用数
 * @param callsPerArticle 每篇预计调用数
 */
export function computeTodayCapacity(callCap: number, usedCalls: number, callsPerArticle: number): number {
  if (!callCap || callCap <= 0) return Number.POSITIVE_INFINITY;   // 未设上限 = 不分片
  const remaining = Math.max(0, callCap - usedCalls);
  const per = Math.max(CALLS_PER_ARTICLE_MIN, callsPerArticle);
  return Math.max(0, Math.floor((remaining * CAPACITY_SAFETY_RATIO) / per));
}

/** 一整天(不含今天已消耗)的满额容量 —— 用来给顺延的行分天 */
export function computeFullDayCapacity(callCap: number, callsPerArticle: number): number {
  if (!callCap || callCap <= 0) return Number.POSITIVE_INFINITY;
  const per = Math.max(CALLS_PER_ARTICLE_MIN, callsPerArticle);
  return Math.max(1, Math.floor((callCap * CAPACITY_SAFETY_RATIO) / per));
}

/**
 * 距离「第 N 天之后的北京时间 00:05」还有多少毫秒。
 * 取 00:05 不取 00:00: 日配额按北京日切归零, 卡零点整会和归零逻辑抢在同一毫秒。
 */
export function delayToBjMidnight(dayOffset: number, now: Date = new Date()): number {
  const BJ = 8 * 3600_000;
  const bjNow = new Date(now.getTime() + BJ);
  const bjMidnight = new Date(bjNow.getTime());
  bjMidnight.setUTCHours(0, 0, 0, 0);
  const target = bjMidnight.getTime() + dayOffset * 86_400_000 + 5 * 60_000;
  return Math.max(0, target - BJ - now.getTime());
}

export interface EnqueuePlan {
  /** 每行分配的 delay(ms), 与传入行同序。0 = 立刻跑 */
  delays: number[];
  /** 今天能跑几行 */
  todayCapacity: number;
  /** 实测每篇调用数 */
  callsPerArticle: number;
  /** 被顺延的行数 */
  deferred: number;
  /** 顺延跨几天 */
  spanDays: number;
}

/**
 * 给一批行算入队 delay: 今天塞满 todayCapacity, 其余按整天容量顺延。
 * 取不到配额信息时**全部 delay=0**(退回原行为), 绝不因为分片器自己挂了就不排产。
 */
export async function planEnqueue(rowCount: number, now: Date = new Date()): Promise<EnqueuePlan> {
  const fallback: EnqueuePlan = {
    delays: new Array(rowCount).fill(0),
    todayCapacity: Number.POSITIVE_INFINITY, callsPerArticle: 0, deferred: 0, spanDays: 0,
  };
  try {
    // 配置与用量都走 llm-guard 的现成出口 —— 分片器与熔断器**必须同一把尺子**,
    // 各读各的 env 迟早漂移(自检里刚吃过"检测工具与被检对象口径不一致"的亏)。
    const [{ getLlmCapConfig, getLlmDailyUsage }, callsPerArticle] = await Promise.all([
      import("../billing/llm-guard.js"),
      estimateCallsPerArticle(),
    ]);
    const cfg = getLlmCapConfig();
    if (!cfg.enabled || !cfg.dailyCallCap || cfg.dailyCallCap <= 0) return fallback;   // 未设上限 = 不分片
    const usage = await getLlmDailyUsage(now);

    const todayCapacity = computeTodayCapacity(cfg.dailyCallCap, usage.calls, callsPerArticle);
    const perDay = computeFullDayCapacity(cfg.dailyCallCap, callsPerArticle);
    if (!Number.isFinite(todayCapacity) || !Number.isFinite(perDay)) return fallback;

    const delays: number[] = [];
    let deferred = 0;
    let maxDay = 0;
    for (let i = 0; i < rowCount; i++) {
      if (i < todayCapacity) { delays.push(0); continue; }
      const dayOffset = 1 + Math.floor((i - todayCapacity) / Math.max(1, perDay));
      maxDay = Math.max(maxDay, dayOffset);
      delays.push(delayToBjMidnight(dayOffset, now));
      deferred++;
    }
    return { delays, todayCapacity, callsPerArticle, deferred, spanDays: maxDay };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "分片: 计划失败, 本批全部立即入队(退回原行为)");
    return fallback;
  }
}
