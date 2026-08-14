/**
 * 检查器台账（8-14 方法论移植 Phase 1）—— 记账 + 自动判定。
 *
 * ## 目标
 *
 * > 措辞闸 37 报 0 中被降级、排名闸 2 报 2 中被保留 —— 这两次都是人肉数出来的。
 * > 移植后：**每个检查器自动记台账，台账自动生成去留建议。**
 *
 * ## 两条硬纪律
 *
 * ① **聚合，不逐条落行。** 命中明细继续走各闸自己的 metadata / ops_incidents；
 *    本表每个 checker 每周一行（upsert）。给最大的表加每条内容一行的判定日志，
 *    收益远小于代价。
 *
 * ② **已裁决数是唯一的成熟度度量。** 未裁决的命中不计入任何结论 ——
 *    「没有被确认为真」不等于「被确认为假」。执行顺序上 Phase 3 的人工反馈入口
 *    晚于本表，前两周 `confirmedTrue` 对每个 checker 恒为 0；没有门槛的话，
 *    所有命中过 20 次的闸（包括正在正常干活的反编造四道闸）都会被建议降级，
 *    第一份周报递到老韩手上就是一页错建议。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { checkerLedger } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { getChecker } from "./checker-registry.js";

/** 判定所需的最小已裁决样本。低于此数一律「台账未成熟，暂不评价」 */
export const MIN_ADJUDICATED = 10;
/** 「累计够多了」的门槛 —— 与已裁决门槛是两回事 */
export const MIN_HITS_FOR_VERDICT = 20;
/** 命中率高于此值视为常数判据（此条**不需要**裁决数据：恒真本身就是证据） */
export const CONSTANT_RATE = 0.95;
/** 影子闸升回主动闸所需的连续真阳性数 */
export const PROMOTE_TRUE_POSITIVES = 2;

/** 该周周一（UTC）—— 聚合键 */
export function weekStart(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=周日
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7)); // 回退到周一
  return d.toISOString().slice(0, 10);
}

/**
 * 记一次检查器运行。**fire-and-forget，绝不阻塞被检查的链路** ——
 * 台账挂了不该让内容生成跟着挂。
 *
 * @param evaluated 本次评估了几次（通常 1）
 * @param hits      本次命中几条（0 = 跑了但没报）
 */
export async function recordCheckerRun(checkerId: string, evaluated: number, hits: number): Promise<void> {
  try {
    const period = weekStart();
    await db
      .insert(checkerLedger)
      .values({ checkerId, periodStart: period, evaluated, hits })
      .onConflictDoUpdate({
        target: [checkerLedger.checkerId, checkerLedger.periodStart],
        set: {
          evaluated: sql`${checkerLedger.evaluated} + ${evaluated}`,
          hits: sql`${checkerLedger.hits} + ${hits}`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, checkerId }, "checker_ledger.record_failed");
  }
}

/** 人工裁决入账（Phase 3 的反馈入口调用） */
export async function recordAdjudication(
  checkerId: string,
  verdict: "true_positive" | "false_positive" | "miss",
): Promise<void> {
  const col =
    verdict === "true_positive" ? "confirmed_true" : verdict === "false_positive" ? "confirmed_false" : "confirmed_miss";
  try {
    const period = weekStart();
    await db
      .insert(checkerLedger)
      .values({ checkerId, periodStart: period, evaluated: 0, hits: 0 })
      .onConflictDoNothing();
    await db
      .update(checkerLedger)
      .set({ [col]: sql`${sql.identifier(col)} + 1`, updatedAt: new Date() } as never)
      .where(and(eq(checkerLedger.checkerId, checkerId), eq(checkerLedger.periodStart, period)));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, checkerId }, "checker_ledger.adjudicate_failed");
  }
}

export interface CheckerStats {
  checkerId: string;
  evaluated: number;
  hits: number;
  confirmedTrue: number;
  confirmedFalse: number;
  confirmedMiss: number;
  /** 已裁决数 = 真 + 假。台账成熟度的唯一度量 */
  adjudicated: number;
  hitRate: number | null;
}

/**
 * 台账**开始记账的日期**（最早一行的写入时刻）。
 *
 * 周报必须把它印出来：「出稿健康」是整周口径，台账只有开始记账之后的数据。
 * 8-14 首份周报同页并列「兜底标题 8（全周）」与「命中 2（昨起）」，
 * 不标窗口的话读者只会当成两个数打架。
 */
export async function ledgerSince(): Promise<string | null> {
  const r = await db.select({ d: sql<string | null>`min(${checkerLedger.createdAt})::date::text` }).from(checkerLedger);
  return r[0]?.d ?? null;
}

/** 汇总近 N 周（默认 4）的台账 */
export async function summarize(weeks = 4): Promise<CheckerStats[]> {
  const since = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      checkerId: checkerLedger.checkerId,
      evaluated: sql<number>`sum(${checkerLedger.evaluated})::int`,
      hits: sql<number>`sum(${checkerLedger.hits})::int`,
      confirmedTrue: sql<number>`sum(${checkerLedger.confirmedTrue})::int`,
      confirmedFalse: sql<number>`sum(${checkerLedger.confirmedFalse})::int`,
      confirmedMiss: sql<number>`sum(${checkerLedger.confirmedMiss})::int`,
    })
    .from(checkerLedger)
    .where(gte(checkerLedger.periodStart, since))
    .groupBy(checkerLedger.checkerId);

  return rows.map((r) => ({
    ...r,
    adjudicated: r.confirmedTrue + r.confirmedFalse,
    hitRate: r.evaluated > 0 ? Number((r.hits / r.evaluated).toFixed(4)) : null,
  }));
}

// ══════════════════════════════════════════════════════════════════
// 自动判定（写死，不用 LLM —— 台账就是为了摆脱"LLM 评 LLM"）
// ══════════════════════════════════════════════════════════════════

export type VerdictLevel = "info" | "warn" | "suggest";

export interface CheckerVerdict {
  checkerId: string;
  level: VerdictLevel;
  /** 给运营看的一句话 */
  message: string;
  /** 建议动作；null = 无需动作 */
  action: string | null;
}

/**
 * 三类判定。**除「常数判据」外，全部要求已裁决 ≥ MIN_ADJUDICATED。**
 *
 * 为什么「常数判据」不需要裁决数据：命中率 >95% 本身就是证据 ——
 * 一个几乎对所有输入都报警的检查器，无论那些命中真假，它都没有判别力。
 * （教训来源：「连续N段无图」曾 100% 命中。）
 */
export function judge(s: CheckerStats): CheckerVerdict {
  const def = getChecker(s.checkerId);
  const mode = def?.mode ?? "active";

  // ① 常数判据 —— 唯一不需要裁决数据的一条
  if (s.hitRate !== null && s.evaluated >= 20 && s.hitRate > CONSTANT_RATE) {
    return {
      checkerId: s.checkerId,
      level: "warn",
      message: `命中率 ${(s.hitRate * 100).toFixed(0)}%（${s.hits}/${s.evaluated}）—— 几乎对所有输入都报警，零判别力`,
      action: "检查判据是否写成了恒真条件",
    };
  }

  // ② 零命中 —— **必须排在"台账未成熟"之前**。
  //   零命中的闸没有可裁决的对象，裁决数恒为 0；此时说它"台账未成熟、
  //   攒够裁决再评价"是**错误归因** —— 攒到天荒地老也不会成熟。
  //   （8-14 首份真实周报实测：10 个闸里 8 个零命中，全被报成"未成熟"，
  //    同一句话重复 8 遍，把真正有信息的 2 行淹了。）
  //   安全闸本就该安静，所以这不是坏消息，只是"这周它没话说"。
  if (s.hits === 0 && s.evaluated >= 200) {
    return {
      checkerId: s.checkerId,
      level: "info",
      // 安慰话留在 message 里, 不留在 action 里 —— 它是**结论的一部分**
      //   ("这不是坏消息"), 不是一个要人去做的动作。
      message: `评估 ${s.evaluated} 次零命中（安全闸本就该安静，不必然是坏事）`,
      action: null,
    };
  }

  // ③ 台账未成熟 —— 门槛之下一律不评价
  if (s.adjudicated < MIN_ADJUDICATED) {
    return {
      checkerId: s.checkerId,
      level: "info",
      message:
        `台账未成熟（已裁决 ${s.adjudicated}/${MIN_ADJUDICATED}，命中 ${s.hits}）—— 暂不评价。` +
        `「没有被确认为真」不等于「被确认为假」`,
      action: null,
    };
  }

  // ④ 够多且零真阳性 → 建议降级
  if (mode === "active" && s.hits >= MIN_HITS_FOR_VERDICT && s.confirmedTrue === 0) {
    return {
      checkerId: s.checkerId,
      level: "suggest",
      message: `累计报 ${s.hits} 条，人工裁决 ${s.adjudicated} 条中真阳性 0 条`,
      action: "建议降级为影子（只记录，不计入违规数）",
    };
  }

  // ⑤ 影子闸攒够真阳性 → 建议升回
  if (mode === "shadow" && s.confirmedTrue >= PROMOTE_TRUE_POSITIVES) {
    return {
      checkerId: s.checkerId,
      level: "suggest",
      message: `影子期内确认真阳性 ${s.confirmedTrue} 条（阈值 ${PROMOTE_TRUE_POSITIVES}）`,
      action: "建议升回主动闸",
    };
  }

  return {
    checkerId: s.checkerId,
    level: "info",
    message: `命中 ${s.hits}/${s.evaluated}，已裁决 ${s.adjudicated}（真 ${s.confirmedTrue} / 假 ${s.confirmedFalse}）`,
    action: null,
  };
}
