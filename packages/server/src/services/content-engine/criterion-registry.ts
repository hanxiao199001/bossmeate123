/**
 * 判据注册器 —— **阈值必须附带它所在量纲的噪音水平**。老韩 8-22 立。
 *
 * ═══ 为什么要一个注册器，而不是"下次小心点" ═══
 *
 * 红线 #20（同一个量的不同度量混用）在四天里发生了三次，**每次都在定阈值的时候**：
 *
 * ```
 * 8-18  时区    心跳间隔算成 486 分钟   naive 时间戳 vs 带时区的，差 8 小时
 * 8-20  边界    "还没有数据" 被判成 "产量塌了"   空窗口 totalSlots=0 触发 rollback
 * 8-22  噪音    总分噪音 4 分(满分100) 拿去卡单维差值(满分10)   件 1 判据全部失效
 * ```
 *
 * 三次都不是粗心，是这类工作的**固有陷阱**：
 * 阈值是个裸数字，它不携带自己的量纲，也不携带"这个量纲上多大算动了"。
 * 靠人每次记得比对，等于把一个可以由类型系统完成的检查交给注意力。
 *
 * ═══ 规矩 ═══
 *
 * 1. `noiseLevel` **必填**。没有实测噪音的判据不许注册 ——
 *    不知道噪音就不知道多大的差算数，那个阈值只是个愿望。
 * 2. `unit` 与 `noiseUnit` **必须全等**，否则注册期抛错。
 *    这条专治 8-22 那次：我本来会把 4.0（总分噪音）填进一个单维判据。
 * 3. `threshold` **必须 > noiseLevel**，否则注册期抛错。
 *    阈值埋在噪音里的判据，无论被测对象如何都答不出东西。
 *    推荐取 2× 噪音（件 2 用的就是 2×1.3 = 2.6）。
 * 4. `noiseMeasuredAt` 必填且会过期：噪音随模型/prompt/温度变，
 *    一个过期的噪音值和填错量纲一样危险。超过 `NOISE_STALE_DAYS` 警告。
 *
 * ═══ 噪音怎么测 ═══
 *
 * **同一批正文、同一把尺子、跑两遍**，取各维/总分的差值绝对值上界。
 * 8-22 实测（n=30，v2 标尺，deepseek-v4-pro）：
 *
 * ```
 * 总分(满分100)   3-4 分
 * 单维(满分10)    ±1.3    最大 +1.34 / -0.44
 * ```
 *
 * 🔴 这两个数**不可互换**。它们描述同一次评分的波动，但量纲差 10 倍。
 */

/** 噪音测量多久算过期（天）。模型或 prompt 一改就该重测，这只是个兜底提醒。 */
export const NOISE_STALE_DAYS = 30;

/** 已知量纲。加新量纲时必须同时给出它的噪音测法，别复用别人的数。 */
export type CriterionUnit =
  /** 六维总分，0-100 */
  | "sixdim_total_0_100"
  /** 六维单维分，0-10 */
  | "sixdim_dim_0_10"
  /** 篇数 */
  | "article_count"
  /** 百分比 0-100 */
  | "percent_0_100";

export interface ScoringCriterion {
  id: string;
  /** 人话：这条判据在断言什么 */
  statement: string;
  /** 阈值。必须 > noiseLevel */
  threshold: number;
  unit: CriterionUnit;
  /** 该量纲上的实测噪音水平（同尺两跑的差值上界） */
  noiseLevel: number;
  /** 必须与 unit 全等 —— 这条专治"填了别的量纲的噪音" */
  noiseUnit: CriterionUnit;
  /** 噪音是怎么测出来的，写清样本量与条件 */
  noiseSource: string;
  /** 噪音测量日期 YYYY-MM-DD */
  noiseMeasuredAt: string;
  /**
   * 方向。`"increase"` = 期望上升；`"no_worse"` = **单向**，只禁变差不禁变好
   * （红线 #18：「持平」一律写成单向）。
   */
  direction: "increase" | "decrease" | "no_worse";
  /** 设为 true 表示这条只作方向性观察，不参与 pass/fail 裁决 */
  observationOnly?: boolean;
}

export class CriterionRegistrationError extends Error {
  constructor(msg: string) {
    super(msg);
    // 🔴 用 name 不用 instanceof —— 跨模块 instanceof 会失效（本项目历史教训）
    this.name = "CriterionRegistrationError";
  }
}

/**
 * 注册期校验。**在实验开跑之前调用**，不通过直接抛错。
 *
 * 8-22 件 1 的那条判据（threshold 0.5 / 单维 / 噪音 1.3）在这里会被拦两次：
 * 阈值小于噪音，且我本来打算填的是总分噪音 4.0（量纲不符）。
 */
export function registerCriteria(list: readonly ScoringCriterion[], today: string): readonly ScoringCriterion[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (seen.has(c.id)) problems.push(`判据 id 重复: ${c.id}`);
    seen.add(c.id);

    // ② 量纲全等
    if (c.unit !== c.noiseUnit) {
      problems.push(
        `[${c.id}] 量纲不符: 阈值单位 ${c.unit}，噪音单位 ${c.noiseUnit} —— ` +
        `拿另一个量纲的噪音校准阈值，正是红线 #20`,
      );
    }

    // ① 噪音必填且有效
    if (!Number.isFinite(c.noiseLevel) || c.noiseLevel < 0) {
      problems.push(`[${c.id}] noiseLevel 无效: ${c.noiseLevel} —— 没有实测噪音的判据不许注册`);
    }

    // ③ 阈值必须穿透噪音（observationOnly 豁免：它本来就不裁决）
    else if (!c.observationOnly && Math.abs(c.threshold) <= c.noiseLevel) {
      problems.push(
        `[${c.id}] 阈值 ${c.threshold} ≤ 噪音 ${c.noiseLevel}（${c.unit}）—— ` +
        `这条判据无论被测对象如何都答不出东西。建议取 2× 噪音 = ${(c.noiseLevel * 2).toFixed(2)}`,
      );
    }

    // ④ 噪音时效
    const days = daysBetween(c.noiseMeasuredAt, today);
    if (!Number.isFinite(days)) {
      problems.push(`[${c.id}] noiseMeasuredAt 不是合法日期: ${c.noiseMeasuredAt}`);
    } else if (days > NOISE_STALE_DAYS) {
      problems.push(
        `[${c.id}] 噪音测于 ${c.noiseMeasuredAt}，已 ${days} 天 —— ` +
        `噪音随模型/prompt 变，过期的噪音值和填错量纲一样危险，请重测`,
      );
    }

    if (!c.noiseSource.trim()) problems.push(`[${c.id}] noiseSource 为空 —— 噪音是怎么来的必须可追溯`);
  }
  if (problems.length > 0) {
    throw new CriterionRegistrationError("判据注册失败：\n  " + problems.join("\n  "));
  }
  return list;
}

/** 纯函数：两个 YYYY-MM-DD 相差天数。非法日期返回 NaN。 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86400_000);
}

/**
 * 8-22 实测噪音表。**改模型/改 prompt 之后必须重测并更新这里。**
 * 测法：同一批正文（冻结样本 n=30）、同一把尺子、独立跑两遍，取差值绝对值上界。
 */
export const MEASURED_NOISE = {
  sixdim_total_0_100: { level: 4.0, at: "2026-08-22", source: "同尺两跑 n=30, v2 标尺, deepseek-v4-pro；实测 A2_new 61.7→64.0、A2_old 51.4→55.9" },
  sixdim_dim_0_10: { level: 1.3, at: "2026-08-22", source: "同尺两跑 n=30, v2 标尺, deepseek-v4-pro；单维最大 +1.34 / -0.44" },
} as const;
