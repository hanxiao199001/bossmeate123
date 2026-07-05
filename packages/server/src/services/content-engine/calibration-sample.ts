/**
 * 7-05 ③: 采用/驳回 → 落库校准样本(写 contents.metadata.calibration)。
 * 记录人工裁决 + 当时六维分/验证器分, 累积成"评分器 vs 人工"标注集, 后台据此校标尺。免 migration。
 *   采用(评分器判待审、人工放行) = 评分器偏严样本; 驳回(评分器判过、人工毙) = 偏松样本。
 * 两条审核路径(/today、/agents/review)共用此函数。
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export async function writeCalibrationSample(
  contentId: string,
  metadata: unknown,
  verdict: "accept" | "reject",
  reason?: string,
): Promise<void> {
  try {
    const md = (metadata ?? {}) as Record<string, any>;
    const sample = {
      verdict,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
      sixDimTotal: md.sixDimTotal ?? null,
      sixDimPassed: md.sixDimPassed ?? null,
      sixDimScores: md.sixDimScores ?? null,
      sixDimDegraded: md.sixDimDegraded ?? null,
      qualityPassed: md.qualityPassed ?? null, // 验证器尺(85/60)
      needsReviewReason: md.needsReviewReason ?? null,
    };
    await db.update(contents)
      .set({ metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify({ calibration: sample })}::jsonb` })
      .where(eq(contents.id, contentId));
  } catch (err) {
    logger.warn({ contentId, err: err instanceof Error ? err.message : err }, "写校准样本失败(非阻塞)");
  }
}
