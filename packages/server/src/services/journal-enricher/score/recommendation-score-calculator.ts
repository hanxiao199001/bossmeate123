/**
 * recommendation_score 算法（B.2.1.A）
 *
 * 5 维加权打分 → integer 1-5
 *   IF      30%
 *   Q 分区  25%
 *   CAR     15%   （B.2.2 才有数据，B.2.1.A 默认 3 分）
 *   Top/Review 15%
 *   APC 成本 15%
 *
 * 不抓数据，纯计算。orchestrator 在 extractor 之后、UPDATE 之前调，
 * 即便所有 fetcher 失败也能基于已有 journal 字段算出一个 default 分数。
 *
 * 5-13 后跑数据观察老板偏好再调权重。
 */

import type { JcrFullShape, PublicationCostsShape } from "../types.js";

export interface ScoreInput {
  /** 影响因子（journals.impact_factor） */
  impactFactor?: number | null;
  /** Q 分区 (journals.partition: Q1 | Q2 | Q3 | Q4) */
  jcrQuartile?: string | null;
  /** B.2.2 才有的 CAR 数据；B.2.1.A 总是 undefined → carScore 走 default */
  carRiskLevel?: "low" | "mid" | "high" | null;
  /** 本 PR 新写入的 jcr_full */
  jcrFull?: JcrFullShape | null;
  /** 本 PR 新写入的 publication_costs */
  publicationCosts?: PublicationCostsShape | null;
}

export function calculateRecommendationScore(input: ScoreInput): number {
  // IF 维度
  const if_ = typeof input.impactFactor === "number" ? input.impactFactor : null;
  const ifScore = if_ == null ? 2 : if_ >= 50 ? 5 : if_ >= 20 ? 4 : if_ >= 10 ? 3 : if_ >= 5 ? 2 : 1;

  // Q 分区维度
  const qMap: Record<string, number> = { Q1: 5, Q2: 3.5, Q3: 2, Q4: 1 };
  const q = (input.jcrQuartile || "").toUpperCase();
  const qScore = qMap[q] ?? 2;

  // CAR 维度（B.2.1.A 大概率 default = 3）
  const carScore =
    input.carRiskLevel === "low" ? 5 :
    input.carRiskLevel === "mid" ? 3 :
    input.carRiskLevel === "high" ? 1 : 3;

  // Top / Review 维度
  const isTop = input.jcrFull?.isTopJournal === true;
  const isReview = input.jcrFull?.isReviewJournal === true;
  const topScore = isTop ? 5 : isReview ? 4 : 2;

  // APC 成本维度（费用越低分越高，符合性价比直觉）
  const apc = input.publicationCosts?.apc;
  const costScore =
    typeof apc !== "number" ? 3 :
    apc < 2000 ? 5 :
    apc < 5000 ? 4 :
    apc < 8000 ? 3 : 2;

  const weighted =
    ifScore * 0.3 +
    qScore * 0.25 +
    carScore * 0.15 +
    topScore * 0.15 +
    costScore * 0.15;

  // clamp 1..5 + integer
  const rounded = Math.round(weighted);
  return Math.max(1, Math.min(5, rounded));
}
