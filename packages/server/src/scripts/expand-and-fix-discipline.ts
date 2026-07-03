/**
 * 合并任务: 5000 拉新 + multidisciplinary 重推 discipline.
 *
 * 用法:
 *   ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     nohup node dist/scripts/expand-and-fix-discipline.js \
 *     > /tmp/expand-fix-$(date +%s).log 2>&1 &'
 *
 * Phase 1: 拉新 5000 期刊 (dedup 现有 515) — 用 expand-journals-pool 逻辑
 * Phase 2: 336 multidisciplinary 期刊用 OpenAlex ISSN 查 topics 重推 discipline
 *
 * 预计: ~6.5 小时 (4500 新 × 5s enrich + 336 × 0.2s API)
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, eq } from "drizzle-orm";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { fetchOpenAlexSources, inferDiscipline, type OpenAlexSource } from "./expand-journals-pool.js";
import { logger } from "../config/logger.js";

const ENRICH_THROTTLE_MS = 5000;
const API_THROTTLE_MS = 200;

// Phase 1: 拉新期刊 (复用 expand-journals-pool 核心逻辑)
async function phase1ExpandPool(targetCount: number) {
  console.log(`\n=== Phase 1: 拉新 ${targetCount} 期刊 ===`);
  const sources = await fetchOpenAlexSources(targetCount);
  console.log(`[phase1] OpenAlex 返回 ${sources.length} 个 sources`);

  const existingRows = await db.select({ issn: journals.issn }).from(journals).where(sql`issn IS NOT NULL`);
  const existingIssns = new Set(existingRows.map(r => r.issn?.trim()).filter(Boolean));
  console.log(`[phase1] DB 已有 ${existingIssns.size} 个 ISSN`);

  let inserted = 0;
  let skipped = 0;
  const newIds: string[] = [];

  for (const s of sources) {
    const issn = s.issn_l || s.issn?.[0] || null;
    if (!issn || existingIssns.has(issn)) { skipped++; continue; }
    existingIssns.add(issn);

    const discipline = inferDiscipline(s);

    try {
      const [row] = await db.insert(journals).values({
        name: s.display_name,
        nameEn: s.display_name,
        issn,
        discipline,
        status: "active",
        source: "openalex",
        dataSource: "openalex_ingest",
        confidence: 60,
        website: s.homepage_url,
      }).onConflictDoNothing().returning({ id: journals.id });

      if (row) { newIds.push(row.id); inserted++; }
      else skipped++;
    } catch { skipped++; }
  }

  console.log(`[phase1] 入库 ${inserted}, 跳过 ${skipped}`);

  // enrich
  console.log(`[phase1] enrich ${newIds.length} 个新期刊 (预计 ${Math.ceil(newIds.length * ENRICH_THROTTLE_MS / 60000)} 分钟)...`);
  let enrichOk = 0, enrichFail = 0;
  for (let i = 0; i < newIds.length; i++) {
    try {
      await enrichJournal(newIds[i]);
      enrichOk++;
    } catch { enrichFail++; }
    if ((i + 1) % 50 === 0) console.log(`[phase1] enrich ${i + 1}/${newIds.length} (ok=${enrichOk}, fail=${enrichFail})`);
    if (i < newIds.length - 1) await new Promise(r => setTimeout(r, ENRICH_THROTTLE_MS));
  }

  console.log(`[phase1] 完成: inserted=${inserted}, enrichOk=${enrichOk}, enrichFail=${enrichFail}`);
  return { inserted, enrichOk, enrichFail };
}

// Phase 2: multidisciplinary 期刊重推 discipline (用 OpenAlex topics)
async function phase2FixDiscipline() {
  console.log(`\n=== Phase 2: 修 multidisciplinary discipline ===`);
  const candidates = await db
    .select({ id: journals.id, nameEn: journals.nameEn, issn: journals.issn })
    .from(journals)
    .where(eq(journals.discipline, "multidisciplinary"));

  console.log(`[phase2] 找到 ${candidates.length} 个 multidisciplinary 期刊`);

  let updated = 0, noData = 0, stillMulti = 0;

  for (let i = 0; i < candidates.length; i++) {
    const j = candidates[i];
    if (!j.issn) { noData++; continue; }

    try {
      const url = `https://api.openalex.org/sources?filter=issn:${j.issn}&mailto=bossmate@example.com`;
      const resp = await fetch(url);
      if (!resp.ok) { noData++; continue; }
      const data = await resp.json() as { results: OpenAlexSource[] };
      const source = data.results?.[0];
      if (!source) { noData++; continue; }

      const discipline = inferDiscipline(source);
      if (discipline && discipline !== "multidisciplinary") {
        await db.update(journals).set({ discipline }).where(eq(journals.id, j.id));
        updated++;
      } else {
        stillMulti++;
      }
    } catch {
      noData++;
    }

    if ((i + 1) % 50 === 0) console.log(`[phase2] progress: ${i + 1}/${candidates.length} (updated=${updated}, stillMulti=${stillMulti}, noData=${noData})`);
    await new Promise(r => setTimeout(r, API_THROTTLE_MS));
  }

  console.log(`[phase2] 完成: updated=${updated}, stillMulti=${stillMulti}, noData=${noData}`);
  return { updated, stillMulti, noData };
}

async function main() {
  const startedAt = Date.now();
  console.log(`[expand-and-fix] 启动 ${new Date().toISOString()}`);

  // 先测 OpenAlex 可用
  try {
    const test = await fetch("https://api.openalex.org/sources?per_page=1&mailto=bossmate@example.com");
    if (!test.ok) {
      console.error(`[expand-and-fix] OpenAlex 不可用: HTTP ${test.status}. 等额度重置后再跑.`);
      process.exit(1);
    }
    console.log("[expand-and-fix] OpenAlex API 可用 ✅");
  } catch (e) {
    console.error("[expand-and-fix] OpenAlex 连接失败:", (e as Error).message);
    process.exit(1);
  }

  const p1 = await phase1ExpandPool(5000);
  const p2 = await phase2FixDiscipline();

  // 最终报告
  const report = await db.execute(sql`
    SELECT discipline, COUNT(*) AS cnt FROM journals
    WHERE confidence >= 60
    GROUP BY discipline ORDER BY cnt DESC
  `);
  const total = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM journals WHERE confidence >= 60`);

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log("\n=== 最终报告 ===");
  console.log(`Phase 1: 新入库 ${p1.inserted}, enrich ${p1.enrichOk}/${p1.inserted}`);
  console.log(`Phase 2: discipline 修正 ${p2.updated}, 仍 multidisciplinary ${p2.stillMulti}`);
  console.log(`总耗时: ${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`);
  console.log(`\n学科分布 (confidence >= 60):`);
  for (const r of (report as any).rows) {
    console.log(`  ${(r.discipline || "(null)").padEnd(20)} ${r.cnt}`);
  }
  console.log(`\n总计: ${(total as any).rows[0].cnt} 本期刊`);
}

main().catch(err => {
  console.error("[expand-and-fix] fatal:", err);
  process.exit(1);
});
