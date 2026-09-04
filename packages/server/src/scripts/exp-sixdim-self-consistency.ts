/**
 * 六维尺子自一致性实验 (9-04) —— 同模型、同 prompt、同一批文章，重评一次，算 r。
 *
 * ## 为什么跑这个
 *
 * 8 月测过 v4-pro vs qwen-plus：**r = 0.254**，30 篇里 14 篇差超 10 分，最大差 41 分，
 * 据此判定"不切主模型"（件 3 换模型省钱这条路的判据）。
 *
 * 但那个数**分不清两件事**：
 *
 * ```
 * 尺子不同（两个模型标准不一样）        → r 低是正常的，件 3 关闭
 * 尺子本身抖（同一个模型每次都不一样）  → r 低说明六维评分本身是噪音
 * ```
 *
 * ▎ 你没法用"一把每次量出不同结果的尺子"去判断另一把尺子准不准。
 *
 * 而 `MEASURED_NOISE`（criterion-registry.ts）只留了**组均值**
 * （`A2_new 61.7→64.0`、`A2_old 51.4→55.9`），逐篇配对数据没留 —— 算不了 r。
 * **这次把原始配对存下来**，别再只留均值。
 *
 * ## 判据（老韩 9-04 预注册，跑之前写死）
 *
 * ```
 * 同模型 r ≥ 0.8    → 尺子稳，r=0.254 成立，件 3 关闭
 * 同模型 r 0.5-0.8  → 件 3 改判据（换模型条件变为相对自身 r）
 * 同模型 r < 0.5    → 🔴 件 3 暂停 —— 这不是成本问题：
 *                      80 分线是画在噪音上的，转内容侧决策
 * ```
 *
 * ## 只读
 *
 * `sixDimQualityCheck` 不落库、只返回分数。本脚本**不写任何正式表**，
 * 只把原始配对写进 JSON。会真实消耗 LLM 调用（约 30 次，按真价 ≈ ¥1）。
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import { sixDimQualityCheck, SIX_DIM_WEIGHTS, type SixDimKey } from "../services/content-engine/quality-check-v2.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { runWithLlmCallAttribution } from "../services/billing/llm-cost.js";

const SAMPLE_SIZE = 30;
const PASS_LINE = 80;

/** Pearson r。样本方差为 0 时返回 null —— 那不是"完全相关", 是没有变异可算 */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function weightedTotal(dims: Record<SixDimKey, { score: number }>): number {
  let t = 0;
  for (const [k, w] of Object.entries(SIX_DIM_WEIGHTS) as Array<[SixDimKey, number]>) {
    t += (dims[k]?.score ?? 0) * w / 10;
  }
  return Math.round(t * 10) / 10;
}

async function main() {
  const res = await db.execute(sql`
    -- 字段名以生产实际为准(9-04 核对): 六维分在 metadata.sixDimScores(扁平 key→0-10),
    -- 总分在 metadata.qualityScore。不是 metadata.sixDim.* —— 那个键在库里不存在。
    SELECT id, title, body,
           (metadata ->> 'qualityScore')::float8 AS old_total,
           metadata -> 'sixDimScores' AS old_dims
    FROM contents
    WHERE type = 'article'
      AND metadata ->> 'qualityScore' IS NOT NULL
      AND metadata -> 'sixDimScores' IS NOT NULL
      AND metadata ->> 'sixDimScoringVersion' = 'v5'
      AND COALESCE(metadata ->> 'sixDimDegraded', 'false') <> 'true'   -- 降级出的分不能当基准
      AND body IS NOT NULL AND length(body) > 500
    ORDER BY created_at DESC
    LIMIT ${SAMPLE_SIZE}
  `);
  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  logger.info({ n: rows.length }, "取样完成");
  if (rows.length < 10) {
    logger.error({ n: rows.length }, "🔴 样本不足 10 篇, 算出来的 r 不可信 —— 中止, 不要出一个假结论");
    process.exit(1);
  }

  const pairs: Array<Record<string, unknown>> = [];
  for (const [i, r] of rows.entries()) {
    const id = String(r.id);
    try {
      const scored = await runWithLlmCallAttribution(
        { tenantId: SYSTEM_RECOMMENDATION_TENANT_ID, contentId: id },
        () => sixDimQualityCheck({
          tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
          title: String(r.title ?? ""),
          body: String(r.body ?? ""),
          contentId: id,
        }),
      );
      if (scored.totalScore === null) {
        logger.warn({ id }, "本篇未评上分(degraded), 不计入 —— 不许拿 0 分当数据");
        pairs.push({ id, skipped: "degraded" });
        continue;
      }
      // sixDimScores 是扁平的 key→number, 不是 {score} 对象 —— 包一层对齐 weightedTotal 的入参
      const flat = (r.old_dims ?? {}) as Record<string, number>;
      const oldDims = Object.fromEntries(
        Object.keys(SIX_DIM_WEIGHTS).map((k) => [k, { score: Number(flat[k]) }]),
      ) as Record<SixDimKey, { score: number }>;
      pairs.push({
        id,
        title: String(r.title ?? "").slice(0, 40),
        run1Total: Number(r.old_total),
        run2Total: scored.totalScore,
        run1Dims: Object.fromEntries(Object.keys(SIX_DIM_WEIGHTS).map((k) => [k, Number.isFinite(flat[k]) ? flat[k] : null])),
        run2Dims: Object.fromEntries((Object.entries(scored.dims) as Array<[string, { score: number }]>).map(([k, v]) => [k, v.score])),
        // 库里的 qualityScore 与六维加权重算值对不对得上 —— 顺手验一下口径
        run1TotalRecomputed: weightedTotal(oldDims),
      });
      logger.info({ i: i + 1, of: rows.length, id, old: r.old_total, new: scored.totalScore }, "重评完成");
    } catch (err) {
      logger.warn({ id, err: err instanceof Error ? err.message : err }, "本篇重评失败, 不计入");
      pairs.push({ id, skipped: "error", err: String(err).slice(0, 200) });
    }
  }

  const valid = pairs.filter((p) => typeof p.run2Total === "number" && typeof p.run1Total === "number");
  const xs = valid.map((p) => p.run1Total as number);
  const ys = valid.map((p) => p.run2Total as number);
  const diffs = valid.map((p) => Math.abs((p.run2Total as number) - (p.run1Total as number))).sort((a, b) => a - b);
  const flips = valid.filter((p) =>
    ((p.run1Total as number) >= PASS_LINE) !== ((p.run2Total as number) >= PASS_LINE)).length;

  const dimR: Record<string, number | null> = {};
  for (const k of Object.keys(SIX_DIM_WEIGHTS)) {
    const a: number[] = [], b: number[] = [];
    for (const p of valid) {
      const x = (p.run1Dims as Record<string, number | null>)[k];
      const y = (p.run2Dims as Record<string, number>)[k];
      if (typeof x === "number" && typeof y === "number") { a.push(x); b.push(y); }
    }
    dimR[k] = pearson(a, b);
  }

  const summary = {
    measuredAt: new Date().toISOString(),
    /**
     * 🔴 从 env 读, 不硬编码(model-name-single-source 守卫抓的就是这个)。
     * 这个字段是实验结论的一部分 —— 写死的话, 哪天主模型切了,
     * 这份 JSON 会**声称**自己测的是 v4-pro, 而实际测的是别的。
     * 一份说谎的实验记录比没有记录更糟: 后来的人会拿它当基准。
     */
    model: env.DEEPSEEK_MODEL_REASONER,
    note: "同模型同 prompt 重评; run1 = 库里已有的 v5 分, run2 = 本次重评",
    n: valid.length, nRequested: SAMPLE_SIZE, nSkipped: pairs.length - valid.length,
    totalR: pearson(xs, ys),
    diffMedian: quantile(diffs, 0.5),
    diffP90: quantile(diffs, 0.9),
    diffMax: diffs[diffs.length - 1] ?? 0,
    flipCount: flips,
    flipRate: valid.length ? flips / valid.length : null,
    passLine: PASS_LINE,
    dimR,
  };

  const out = resolve(new URL("../services/content-engine/", import.meta.url).pathname, "sixdim-self-consistency-20260904.json");
  writeFileSync(out, JSON.stringify({ summary, pairs }, null, 2), "utf8");
  console.log("RESULT " + JSON.stringify(summary));
  console.log("RAW_SAVED " + out);
  process.exit(0);
}

main().catch((e) => { logger.fatal(e, "实验失败"); process.exit(1); });
