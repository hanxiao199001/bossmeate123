/**
 * 重算所有期刊 recommendationScore (PR-I6 中文核心维度上线后用)。
 * 国际刊分数不变(公式未改); 中文核心刊从旧的一律 2 分 → 按目录强度重算。
 * 用法: node dist/scripts/recompute-recommendation-scores.js [--apply]
 *   不带 --apply 只统计将变更多少, 带 --apply 才写库。
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { eq } from "drizzle-orm";
import { calculateRecommendationScore } from "../services/journal-enricher/score/recommendation-score-calculator.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.select({
    id: journals.id, impactFactor: journals.impactFactor, partition: journals.partition,
    jcrFull: journals.jcrFull, publicationCosts: journals.publicationCosts,
    pkuCoreLevel: journals.pkuCoreLevel, cscdLevel: journals.cscdLevel, catalogs: journals.catalogs,
    cur: journals.recommendationScore,
  }).from(journals);

  let changed = 0;
  const dist: Record<string, number> = {};
  for (const r of rows) {
    const score = calculateRecommendationScore({
      impactFactor: r.impactFactor, jcrQuartile: r.partition,
      carRiskLevel: null, jcrFull: (r.jcrFull as any) || null,
      publicationCosts: (r.publicationCosts as any) || null,
      pkuCoreLevel: (r as any).pkuCoreLevel ?? null, cscdLevel: (r as any).cscdLevel ?? null,
      catalogs: Array.isArray((r as any).catalogs) ? (r as any).catalogs : null,
    });
    dist[String(score)] = (dist[String(score)] ?? 0) + 1;
    if (score !== (r.cur as any)) {
      changed++;
      if (apply) await db.update(journals).set({ recommendationScore: score }).where(eq(journals.id, r.id));
    }
  }
  console.log(`[recompute] 总 ${rows.length} | 将变更 ${changed} | ${apply ? "已写库" : "未写库(加 --apply 生效)"}`);
  console.log(`[recompute] 新分布:`, dist);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
