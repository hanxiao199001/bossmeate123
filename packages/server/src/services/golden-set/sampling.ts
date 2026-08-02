/**
 * Golden Set 采样策略 —— 纯函数, 不碰 DB(所以能单测到每一条代表性规则)。
 *
 * 【要解决的问题】
 *   老板只标 40-50 篇, 这 50 篇要能代表整个内容池。最容易犯的错是"标最近的 50 篇" ——
 *   那是同一周、同一批 prompt、同一个学科的 50 个样本, 相关性算出来好看, 但换个月的数据全废。
 *
 * 【怎么保证代表性】按四个维度分层配额:
 *   ① 分数段(high/mid/low/unscored) —— 这是最关键的一维。全标高分内容, 人机判断都说"好",
 *      相关性会虚高到没有信息量; 必须让低分/未评分样本进来, 才测得出评分器在哪儿翻车。
 *      ⚠️ unscored 单列一档: 7-27 事故的教训是"0 分 ≠ 未评分"(质检超时 → 根本没评上分),
 *      把未评分当 0 分塞进 low 会污染整个低分层。
 *   ② 内容形态(国内刊/国际刊/盘点/视频)
 *   ③ 生命周期状态(published / needs_review / 其他)
 *   ④ 时间(按 ISO 周分桶, 强制打散)
 *
 * 【算法】配额驱动 + 贪心去重, 完全确定性(同一输入永远同一输出, 便于回归测试):
 *   每轮先挑"离配额差得最远"的分数段, 再在该段内选一个让 ②③④ 三个计数器最均衡的候选。
 *   某一层不够填(比如低分内容天然少), 剩余名额自动流给其他层, 绝不因为凑不齐配额就少给样本。
 *
 * ⚠️ 采样**用**分数, 但分数绝不出现在返回给前端的卡片里(见 anchor-guard.ts)。
 *   本模块只返回 id 列表, 分数段留在服务端。
 */

/** 分数段。unscored 与 low 必须分开, 见文件头 ①。 */
export type ScoreBand = "high" | "mid" | "low" | "unscored";

export const SCORE_BANDS: readonly ScoreBand[] = ["high", "mid", "low", "unscored"];

/** 80 分线是项目既有的出稿标准(《内容质量评分标准-80分线》), 分段围绕它切。 */
export const BAND_THRESHOLDS = { high: 85, mid: 70 } as const;

export interface PoolItem {
  id: string;
  /** 六维总分; null = 没评上分(不是 0 分) */
  score: number | null;
  /** 评分降级 = 主+降级模型都没救回来, 这篇根本没评上分(7-27) */
  degraded?: boolean;
  /** 内容形态维度的分层键 */
  kind: string;
  /** 生命周期状态维度的分层键 */
  status: string;
  createdAt: Date | string;
}

/**
 * 分数 → 分数段。
 * degraded 或 score 非有限数 → unscored。**不要**把 null 当 0 分。
 */
export function scoreBand(score: number | null | undefined, degraded?: boolean): ScoreBand {
  if (degraded === true) return "unscored";
  if (typeof score !== "number" || !Number.isFinite(score)) return "unscored";
  if (score >= BAND_THRESHOLDS.high) return "high";
  if (score >= BAND_THRESHOLDS.mid) return "mid";
  return "low";
}

/** 时间分桶: ISO 年-周。同一周的内容算同一个桶, 采样时互相排斥。 */
export function weekBucket(d: Date | string): string {
  const date = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  if (Number.isNaN(date.getTime())) return "unknown";
  // ISO week: 挪到本周四再算年内第几周(跨年周归属才正确)
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // 周一=0
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface SampleResult {
  /** 选中的 id, 顺序即建议的标注顺序(已按分数段交替打散, 老板不会连着标 10 篇高分) */
  ids: string[];
  /** 各分数段实际选中数(服务端日志/统计用, 不下发前端) */
  bandCounts: Record<ScoreBand, number>;
  kindCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  weekCounts: Record<string, number>;
}

/**
 * 分层采样。
 * @param pool 候选池(调用方已做租户/时间窗过滤)
 * @param limit 目标条数
 */
export function planSample(pool: readonly PoolItem[], limit: number): SampleResult {
  const target = Math.max(0, Math.floor(limit));
  const empty: SampleResult = {
    ids: [],
    bandCounts: { high: 0, mid: 0, low: 0, unscored: 0 },
    kindCounts: {},
    statusCounts: {},
    weekCounts: {},
  };
  if (target === 0 || pool.length === 0) return empty;

  // ---- 按分数段建桶。桶内按"周分散优先"稳定排序, 让同一层内部也不会先啃完最近一周。
  const buckets: Record<ScoreBand, PoolItem[]> = { high: [], mid: [], low: [], unscored: [] };
  for (const item of pool) {
    buckets[scoreBand(item.score, item.degraded)].push(item);
  }

  const bandCounts: Record<ScoreBand, number> = { high: 0, mid: 0, low: 0, unscored: 0 };
  const kindCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const weekCounts: Record<string, number> = {};
  const picked: string[] = [];
  const usedIds = new Set<string>();

  // 配额: 有内容的分数段均分名额(空段不占坑, 名额留给别人)
  const liveBands = SCORE_BANDS.filter((b) => buckets[b].length > 0);
  const quota: Record<ScoreBand, number> = { high: 0, mid: 0, low: 0, unscored: 0 };
  for (let i = 0; i < liveBands.length; i++) {
    const base = Math.floor(target / liveBands.length);
    const extra = i < target % liveBands.length ? 1 : 0;
    quota[liveBands[i]!] = Math.min(base + extra, buckets[liveBands[i]!]!.length);
  }

  /** 越小越"新鲜"(该维度上还没怎么被采过) */
  const cost = (it: PoolItem) =>
    (kindCounts[it.kind] ?? 0) * 100 + (statusCounts[it.status] ?? 0) * 10 + (weekCounts[weekBucket(it.createdAt)] ?? 0);

  const takeFrom = (band: ScoreBand): boolean => {
    const bucket = buckets[band];
    let best: PoolItem | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const it of bucket) {
      if (usedIds.has(it.id)) continue;
      const c = cost(it);
      if (c < bestCost) {
        best = it;
        bestCost = c;
        if (c === 0) break; // 已是最优, 不必再扫
      }
    }
    if (!best) return false;
    usedIds.add(best.id);
    picked.push(best.id);
    bandCounts[band]++;
    kindCounts[best.kind] = (kindCounts[best.kind] ?? 0) + 1;
    statusCounts[best.status] = (statusCounts[best.status] ?? 0) + 1;
    const wk = weekBucket(best.createdAt);
    weekCounts[wk] = (weekCounts[wk] ?? 0) + 1;
    return true;
  };

  // ---- 第一轮: 按配额轮转填(轮转 = 结果顺序天然在分数段之间交替)
  let guard = 0;
  while (picked.length < target && guard++ < target * SCORE_BANDS.length + 10) {
    // 挑"配额缺口最大"的段; 并列时按 SCORE_BANDS 固定顺序(确定性)
    let chosen: ScoreBand | undefined;
    let bestDeficit = 0;
    for (const b of SCORE_BANDS) {
      const deficit = quota[b] - bandCounts[b];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        chosen = b;
      }
    }
    if (!chosen) break;
    if (!takeFrom(chosen)) quota[chosen] = bandCounts[chosen]; // 该段抽干了, 把配额收回
  }

  // ---- 第二轮: 配额都填满还没到 target(某些段天然稀缺) → 剩余名额按同一贪心规则流给还有货的段
  guard = 0;
  while (picked.length < target && guard++ < target * SCORE_BANDS.length + 10) {
    // 优先补"当前采到最少"的段, 保持分布尽量平
    const avail = SCORE_BANDS.filter((b) => buckets[b].some((it) => !usedIds.has(it.id)));
    if (avail.length === 0) break;
    avail.sort((a, b) => bandCounts[a] - bandCounts[b] || SCORE_BANDS.indexOf(a) - SCORE_BANDS.indexOf(b));
    if (!takeFrom(avail[0]!)) break;
  }

  return { ids: picked, bandCounts, kindCounts, statusCounts, weekCounts };
}
