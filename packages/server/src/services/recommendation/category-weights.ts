/**
 * 7-06 ③ 选题飞轮真实化 — 学科/题材权重从"全 1 空转"接上真实阅读数据。
 *
 * 算法 (normalizeCategoryWeights, 纯函数可单测):
 *   1. 每学科取近 windowDays 天内容的"最新累计快照"阅读表现 (views, 阅读为 0 用互动代理
 *      likes*10+comments*15+shares*20 — 与 asset-performance PR-B2 同口径)
 *   2. 样本 < MIN_CATEGORY_SAMPLES(3) 篇的学科不动 (权重=1), 防单篇爆款代表整个学科
 *   3. ratio = 学科均值 / 全局均值 → log2 缩放减半: damped = clamp(log2(ratio)/2, -1, 1)
 *      → weight = 2^damped ∈ [0.5, 2.0]
 *
 * 防爆设计:
 *   - log 缩放: 10 倍爆款学科 ratio=10 → log2≈3.32 → /2≈1.66 → clamp 到 1 → 权重封顶 2.0,
 *     线性比例下它会是 10.0 直接吃掉全部推荐位
 *   - 上下限 [0.5, 2.0]: 最差学科也保留一半基准分 (不清零, 留翻身机会)
 *   - AVG + 最少 3 篇样本: 单篇 10w+ 不足以拉动学科权重
 *   - 无数据/查询失败: 返回空 map, 调用方 `factors.get(x) || 1` 自然回退全 1 (行为同上线前)
 */
import { logger } from "../../config/logger.js";

export const WEIGHT_MIN = 0.5;
export const WEIGHT_MAX = 2.0;
export const MIN_CATEGORY_SAMPLES = 3;

export interface CategoryPerf {
  /** 该学科近窗口平均阅读表现 (views 或互动代理) */
  avg: number;
  /** 参与统计的内容篇数 */
  samples: number;
}

/**
 * 纯函数: 学科表现 → 归一化权重因子。
 * 只对"样本足够 & 有正表现"的学科产出权重, 其余学科由调用方回退 1。
 */
export function normalizeCategoryWeights(
  perf: Record<string, CategoryPerf>,
  opts?: { minSamples?: number },
): Record<string, number> {
  const minSamples = opts?.minSamples ?? MIN_CATEGORY_SAMPLES;
  const eligible = Object.entries(perf).filter(
    ([, p]) => p.samples >= minSamples && p.avg > 0,
  );
  if (eligible.length === 0) return {};
  const globalAvg = eligible.reduce((s, [, p]) => s + p.avg, 0) / eligible.length;
  if (!(globalAvg > 0)) return {};

  const out: Record<string, number> = {};
  for (const [cat, p] of eligible) {
    const ratio = p.avg / globalAvg;
    // log2 缩放减半 + clamp [-1, 1] → 2^x ∈ [0.5, 2.0]
    const damped = Math.max(-1, Math.min(1, Math.log2(ratio) / 2));
    const w = Math.pow(2, damped);
    out[cat] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Number(w.toFixed(4))));
  }
  return out;
}

/**
 * 从 content_metrics 聚合近 windowDays 天各学科真实阅读表现 → 权重 Map。
 * DB 依赖走动态 import, 保持本模块顶层零副作用 (单测只 import 纯函数不拉 env/db)。
 */
export async function computeCategoryWeights(windowDays = 30): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { db } = await import("../../models/db.js");
    const { sql } = await import("drizzle-orm");
    // 每内容取窗口内"最新一条快照"(7-06 起 wechat 回流写的是累计值), 再按学科 AVG
    const res = await db.execute(sql`
      SELECT disc, AVG(v) AS av, COUNT(*) AS n FROM (
        SELECT DISTINCT ON (cm.content_id)
          c.metadata->>'discipline' AS disc,
          GREATEST(cm.views, cm.likes*10 + cm.comments*15 + cm.shares*20) AS v
        FROM content_metrics cm
        JOIN contents c ON c.id = cm.content_id
        WHERE c.metadata->>'discipline' IS NOT NULL
          AND cm.snapshot_date >= (CURRENT_DATE - ${windowDays}::int)
        ORDER BY cm.content_id, cm.snapshot_date DESC
      ) t
      WHERE v > 0
      GROUP BY disc`);
    const rows = (((res as any).rows ?? []) as Array<{ disc: string; av: string; n: string }>);
    const perf: Record<string, CategoryPerf> = {};
    for (const r of rows) {
      if (!r.disc) continue;
      perf[r.disc] = { avg: Number(r.av) || 0, samples: Number(r.n) || 0 };
    }
    const weights = normalizeCategoryWeights(perf);
    for (const [k, v] of Object.entries(weights)) map.set(k, v);
    if (map.size > 0) {
      logger.info({ windowDays, weights: Object.fromEntries(map) }, "7-06 ③ 学科权重已接真实阅读数据");
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "7-06 ③ 学科权重聚合失败 (回退全1)");
  }
  return map;
}
