/**
 * PR #179 — 回填 journals.discipline (从 OpenAlex API 重新查 topics).
 *
 * 用法:
 *   ssh ubuntu@122.152.234.155 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/backfill-discipline.js'
 *
 * 行为:
 *   1. SELECT journals WHERE discipline IS NULL (or 空)
 *   2. 对每个: 用 ISSN 查 OpenAlex /sources API → 拿 topics → inferDiscipline
 *   3. UPDATE journals SET discipline = inferred
 *   4. 输出分布报告
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, eq, or, isNull } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { type OpenAlexSource, inferDiscipline } from "./expand-journals-pool.js";

const THROTTLE_MS = 200; // OpenAlex 允许 100 req/s, 200ms 足够保守

async function lookupOpenAlexByIssn(issn: string): Promise<OpenAlexSource | null> {
  try {
    const url = `https://api.openalex.org/sources?filter=issn:${issn}&mailto=bossmate@example.com`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json() as { results: OpenAlexSource[] };
    return data.results?.[0] ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // 查 discipline 为 NULL 或空的 journals
  const candidates = await db
    .select({ id: journals.id, name: journals.name, nameEn: journals.nameEn, issn: journals.issn })
    .from(journals)
    .where(or(isNull(journals.discipline), eq(journals.discipline, "")));

  console.log(`[backfill-discipline] 找到 ${candidates.length} 个 discipline=NULL 的期刊`);

  let updated = 0;
  let failed = 0;
  let stillNull = 0;

  for (let i = 0; i < candidates.length; i++) {
    const j = candidates[i];
    if (!j.issn) {
      stillNull++;
      continue;
    }

    const source = await lookupOpenAlexByIssn(j.issn);
    if (!source) {
      stillNull++;
      if ((i + 1) % 50 === 0) console.log(`[backfill] progress: ${i + 1}/${candidates.length}`);
      await new Promise(r => setTimeout(r, THROTTLE_MS));
      continue;
    }

    const discipline = inferDiscipline(source);
    if (discipline) {
      try {
        await db.update(journals).set({ discipline }).where(eq(journals.id, j.id));
        updated++;
      } catch {
        failed++;
      }
    } else {
      stillNull++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`[backfill] progress: ${i + 1}/${candidates.length} (updated=${updated}, stillNull=${stillNull}, failed=${failed})`);
    }
    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }

  // 报告
  const report = await db.execute(sql`
    SELECT discipline, COUNT(*) AS cnt FROM journals
    WHERE confidence >= 60
    GROUP BY discipline ORDER BY cnt DESC
  `);

  console.log("\n=== 回填后学科分布 ===");
  for (const r of (report as any).rows) {
    console.log(`  ${(r.discipline || "(null)").padEnd(20)} ${r.cnt}`);
  }

  console.log(`\n[backfill-discipline] 完成: updated=${updated}, stillNull=${stillNull}, failed=${failed}`);
}

main().catch(err => {
  console.error("[backfill-discipline] fatal:", err);
  process.exit(1);
});
