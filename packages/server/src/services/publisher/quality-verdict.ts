/**
 * 分发时的「达标 / 未达标」快照。8-20 建（老韩拍板）。
 *
 * ═══ 为什么要这个东西 ═══
 *
 * 8-20 实测：近 14 天进入分发的 103 篇里，86 篇（83.5%）没过六维线。
 * 而我们**答不出**「多而差 vs 少而精哪个对生意更好」—— 因为没有阅读数据。
 *
 * 老韩的处置：**在还不能测量的时候，先把标记打好，让将来的测量能回溯。**
 *
 *   现在两类内容都在发，只是没人记得住哪篇是哪类。
 *   等 wechat_stats 接上，如果今天开始打标，那时立刻就有【现成的对照组】——
 *   不用再等一个实验期。打标几乎零成本，却把因果分析提前了一个月。
 *
 * ═══ 为什么记在 publish_log 而不是直接读 contents.metadata ═══
 *
 * `contents.metadata.sixDimPassed` 确实已经存着，看起来这张快照是冗余的。它不是：
 *
 *   1. **时点**。log 行记的是「**我们按下发布键的那一刻**知道什么」。
 *      metadata 后来被任何东西改写（重评、回填、人工改판），历史就没了。
 *      对照实验要的恰恰是「当时的判断」，不是「现在的判断」。
 *   2. **可 join**。将来的 wechat_stats 按 (content_id, account_id) 落行，
 *      与 log 同键。verdict 在 log 上 = 一次 join 就能出「达标组阅读数 vs 未达标组阅读数」。
 *   3. **口径冻结**。达标线将来可能改（80 → 别的数）。改了之后再回头算历史，
 *      算出来的是「按新线，当年那批算不算达标」—— 那不是当年的对照组。
 *
 * ═══ 三档，不是两档 ═══
 *
 * `unscored` 必须独立成一档，不许并进 `below_bar`：
 * 近 14 天进分发的 103 篇里有 **29 篇从没跑过六维**（28 篇 status=generated）。
 * 那不是「评分低」，是**评分环节根本没执行** —— 两者对「该不该发」的答案可能一样，
 * 但对「为什么会这样」的答案完全不同，混成一档就再也分不开了（红线 #20）。
 */

/** 分发时点的质量判定。三档语义见文件头。 */
export type QualityVerdict =
  /** 六维总分 ≥80 且每维 ≥6 */
  | "passed"
  /** 跑过六维但没到线 */
  | "below_bar"
  /** 根本没跑过六维 —— 与 below_bar 是两件事，不许合并 */
  | "unscored";

export interface QualitySnapshot {
  verdict: QualityVerdict;
  /** 当时的六维总分；unscored 时为 null */
  sixDimTotal: number | null;
}

/**
 * 从 contents.metadata 读出分发时点的质量快照。**纯函数**，零 DB / 零网络。
 *
 * 判定**只读 `sixDimPassed`，不自己重算** —— 重算就等于在这里复制一份达标线，
 * 而达标线的唯一定义在 `content-engine/quality-thresholds.ts`。
 * 复制判据 = 两处迟早漂移（`fallback-messages.ts` 注释里那个经典失效）。
 */
export function resolveQualitySnapshot(metadata: unknown): QualitySnapshot {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const rawTotal = m.sixDimTotal;
  const total =
    typeof rawTotal === "number" && Number.isFinite(rawTotal)
      ? rawTotal
      : typeof rawTotal === "string" && rawTotal.trim() !== "" && Number.isFinite(Number(rawTotal))
        ? Number(rawTotal)
        : null;

  // 没跑过六维：既没有总分，也没有维度明细
  if (total === null && m.sixDimScores == null) {
    return { verdict: "unscored", sixDimTotal: null };
  }
  // 有评分痕迹但 sixDimPassed 缺失 —— 也算 unscored，但把总分留下来供排查。
  // 🔴 不许在这里"总分 ≥80 就当 passed" —— 那是漏掉了每维 ≥6 的地板（红线 #20 的形态：
  //    总分和地板是两个判据，只看前一个会把被地板挡下的算成达标）。
  if (typeof m.sixDimPassed !== "boolean") {
    return { verdict: "unscored", sixDimTotal: total };
  }
  return { verdict: m.sixDimPassed ? "passed" : "below_bar", sixDimTotal: total };
}
