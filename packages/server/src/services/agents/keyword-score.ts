/**
 * 关键词综合分（8-17 重写）—— **纯函数，无 DB、无 IO，可测**。
 *
 * ## 为什么重写：旧公式打到人人满分，等于没打分
 *
 * 旧式：`compositeScore = totalHeatScore × platformMultiplier × industryMultiplier`
 *
 * 实测（8-17，active 2938 条）：
 * ```
 * heat_score 只有 8 个不同值，1098 条卡在 100 天花板
 * composite ≥ 300 的正好也是 1098 条 = 37.4% 并列满分
 * ```
 *
 * 三个因子逐一看，没有一个在区分：
 *   · `industryMultiplier = ×3` 对**所有入库词**都成立 —— Step 5 只入库行业相关的，
 *     于是这个"权重"是恒定乘数，零判别力；
 *   · `platformMultiplier` 绝大多数 = 1（单平台）；
 *   · `heat_score` 上游截在 100，大批词直接顶格。
 *
 * 公式因此退化成 `heat × 3`，而 heat 饱和 → **1098 条并列，排序退化成插入序**。
 * 后果是 8-16 那晚：24 行排产、topic 只有 1 个 —— 稳定地选到同一批词。
 *
 * 这与「连续 N 段无图 100% 命中」「六维恒定 5/5 星」是同一族问题：
 * **判据/打分对几乎所有输入给同一个值，它就不再是判据。**
 *
 * ## 🔴 压缩救不了饱和
 *
 * 归一化、对数压缩都是**单调变换** —— 作用在"人人 100"上，结果还是人人一样。
 * 所以修法不是压缩旧分数，是**把真正散开的维度接进来**：
 *
 * | 维度 | 实测分布 | 作用 |
 * |---|---|---|
 * | `appearCount` | 1~174，137 个不同值 | 主区分：持续出现 = 真热度 |
 * | `lastSeenAt` | 跨 113 天 | 新鲜度：老词自然沉底 |
 * | `platforms` | 多数 1，少数 2+ | 跨平台佐证 |
 * | `heatScore` | 8 个值、大量顶格 | 保留但**权重最低**（它已经不可信） |
 * | `lastRecommendedAt` | 279/2938 有值 | **防霸榜**：刚用过的压一压 |
 *
 * 验收（老韩定）：满分条数 < 总数 5%，TOP100 有梯度。
 */

/** 打分输入 —— 全部来自 keywords 表已有列，不需要新采集 */
export interface KeywordScoreInput {
  /** 上游热度，0-100（**已饱和**，谨慎使用） */
  heatScore: number;
  /** 累计出现次数（主区分信号） */
  appearCount: number;
  /** 最近一次被采集到 */
  lastSeenAt: Date | string | null;
  /** 出现在几个平台 */
  platformCount: number;
  /** 最近一次被选为选题（防霸榜） */
  lastRecommendedAt?: Date | string | null;
  /** 评分基准时刻（测试要可复现，所以显式传） */
  now: Date;
}

/** 各维度权重。合计 100 —— 满分是 100 分制，便于人读 */
export const WEIGHTS = {
  /** 主区分 */
  appear: 45,
  /** 新鲜度 */
  recency: 25,
  /** 跨平台佐证 */
  platform: 15,
  /** 上游热度 —— 饱和，只给它这么多 */
  heat: 15,
} as const;

/** 刚被选过的词要压一压，避免同一批词天天霸榜（乘性惩罚，最低压到 40%） */
export const RECENT_PICK_FLOOR = 0.4;
/** 惩罚衰减天数：距上次被选 ≥ 这么多天，惩罚归零 */
export const RECENT_PICK_DAYS = 14;
/** 新鲜度半衰期（天） */
export const RECENCY_HALFLIFE_DAYS = 21;
/** appearCount 的对数底数参考值：出现这么多次拿满分 */
export const APPEAR_SATURATION = 150;

const days = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 86_400_000;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const toDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * 综合分 0-100。
 *
 * 各分量都先归一到 0-1 再加权 —— 这样任何一维上游改了量纲，
 * 也不会像旧公式那样把整个分数带偏。
 */
export function computeKeywordScore(input: KeywordScoreInput): number {
  // ① 出现次数：log 压缩。1 次 → 0，150 次 → 1。
  //    用 log 是因为 1→10 的差别远比 140→150 有意义。
  const appear = clamp01(Math.log1p(Math.max(0, input.appearCount - 1)) / Math.log1p(APPEAR_SATURATION));

  // ② 新鲜度：指数半衰。21 天前的词剩一半分。
  const seen = toDate(input.lastSeenAt);
  const recency = seen ? clamp01(Math.pow(0.5, Math.max(0, days(input.now, seen)) / RECENCY_HALFLIFE_DAYS)) : 0;

  // ③ 跨平台：2 个平台就接近满分（跨平台本身是强佐证，但边际收益递减）
  const platform = clamp01((Math.max(1, input.platformCount) - 1) / 2);

  // ④ 上游热度：**饱和信号**，归一后只占 15 分。
  const heat = clamp01(input.heatScore / 100);

  const base =
    WEIGHTS.appear * appear + WEIGHTS.recency * recency + WEIGHTS.platform * platform + WEIGHTS.heat * heat;

  // ⑤ 防霸榜：刚被选过的乘性打压，14 天线性恢复。
  //    乘性而非减法 —— 减法会把低分词压成负数再被 clamp，等于对它们没惩罚。
  const picked = toDate(input.lastRecommendedAt ?? null);
  const sincePick = picked ? Math.max(0, days(input.now, picked)) : Infinity;
  const penalty =
    sincePick >= RECENT_PICK_DAYS
      ? 1
      : RECENT_PICK_FLOOR + (1 - RECENT_PICK_FLOOR) * (sincePick / RECENT_PICK_DAYS);

  return Math.round(base * penalty * 100) / 100;
}

/**
 * 分布体检 —— 验收判据的可执行形式。
 *
 * 「满分条数 < 5%」「TOP100 有梯度」这两句话必须能被跑出来，
 * 否则下次有人改了权重，没人知道分布又塌了。
 */
export function scoreDistributionHealth(scores: number[]): {
  total: number;
  maxScore: number;
  atMaxCount: number;
  atMaxRatio: number;
  top100DistinctRatio: number;
  healthy: boolean;
  reasons: string[];
} {
  const total = scores.length;
  const sorted = [...scores].sort((a, b) => b - a);
  const maxScore = sorted[0] ?? 0;
  const atMaxCount = sorted.filter((s) => s === maxScore).length;
  const atMaxRatio = total > 0 ? atMaxCount / total : 0;
  const top100 = sorted.slice(0, Math.min(100, total));
  const top100DistinctRatio = top100.length > 0 ? new Set(top100).size / top100.length : 0;

  const reasons: string[] = [];
  if (atMaxRatio >= 0.05) reasons.push(`并列满分 ${atMaxCount}/${total} = ${(atMaxRatio * 100).toFixed(1)}%（阈值 5%）`);
  if (top100DistinctRatio < 0.5) reasons.push(`TOP100 只有 ${(top100DistinctRatio * 100).toFixed(0)}% 是不同分值，梯度不足`);

  return { total, maxScore, atMaxCount, atMaxRatio, top100DistinctRatio, healthy: reasons.length === 0, reasons };
}
