/**
 * 5-23 PR #165a + #165b — 全表跑 enrichJournal, 拿源覆盖度报告.
 *
 * 用法 (prod):
 *   ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/run-enrichment-backfill.js'
 *
 * 行为:
 *   1. SELECT 全部 journals (按 created_at)
 *   2. 顺序跑 enrichJournal(id) — 每次间隔 2 秒避免 letpub 反爬
 *   3. 跑完后 print 2 类报告:
 *      a) 每源命中/失败/超时计数 (从 journal_enrichment_log)
 *      b) 每字段最常见来源 (从 journals.field_provenance)
 *   4. 失败 journal id 列表 + reason
 *
 * 总时长估算: 48 journal × (2s 间隔 + ~3s 跑) ≈ 4 min
 */
import { db } from "../models/db.js";
import { journals, journalEnrichmentLog } from "../models/schema.js";
import { sql } from "drizzle-orm";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { logger } from "../config/logger.js";

const THROTTLE_MS = 2000; // 2s 间隔 letpub 不发飙

async function main() {
  const allJournals = await db.select({ id: journals.id, name: journals.name, nameEn: journals.nameEn }).from(journals);
  console.log(`[backfill] 找到 ${allJournals.length} journal, 开始跑 (预计 ${Math.ceil(allJournals.length * (THROTTLE_MS + 3000) / 60000)} 分钟)`);

  let success = 0;
  let failed = 0;
  const failedList: Array<{ id: string; name: string; reason: string }> = [];

  for (let i = 0; i < allJournals.length; i++) {
    const j = allJournals[i]!;
    try {
      await enrichJournal(j.id);
      success++;
      if ((i + 1) % 10 === 0) console.log(`  [progress] ${i + 1}/${allJournals.length} (${success} ok, ${failed} fail)`);
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      failedList.push({ id: j.id, name: j.nameEn || j.name, reason: reason.slice(0, 200) });
      logger.warn({ journalId: j.id, err: reason }, "enrich failed in backfill");
    }
    if (i < allJournals.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  console.log(`\n[backfill] 完成: ${success} success, ${failed} failed`);

  // === 报告 a: 每源命中分布 ===
  console.log("\n=== a) 每源命中/失败/超时 + 平均耗时 (从 journal_enrichment_log) ===");
  const sourceStats = await db.execute(sql`
    SELECT source,
      COUNT(*) FILTER (WHERE status = 'success') AS success_cnt,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_cnt,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_cnt,
      COUNT(*) FILTER (WHERE status = 'timeout') AS timeout_cnt,
      ROUND(AVG(duration_ms)::numeric, 0) AS avg_ms,
      MAX(duration_ms) AS max_ms
    FROM journal_enrichment_log
    WHERE attempted_at >= NOW() - INTERVAL '1 hour'
    GROUP BY source
    ORDER BY source
  `);
  const rows = (sourceStats as any).rows || sourceStats;
  for (const r of rows) {
    const total = Number(r.success_cnt) + Number(r.skipped_cnt) + Number(r.failed_cnt) + Number(r.timeout_cnt);
    const successRate = total > 0 ? Math.round((Number(r.success_cnt) / total) * 100) : 0;
    console.log(`  ${r.source.padEnd(10)} ok=${r.success_cnt} skip=${r.skipped_cnt} fail=${r.failed_cnt} timeout=${r.timeout_cnt}  rate=${successRate}%  avg=${r.avg_ms}ms max=${r.max_ms}ms`);
  }

  // === 报告 b: 每字段来源分布 ===
  console.log("\n=== b) 每字段最常见来源 (journals.field_provenance) ===");
  const provenanceStats = await db.execute(sql`
    SELECT key AS field, value AS source, COUNT(*) AS cnt
    FROM journals, jsonb_each_text(COALESCE(field_provenance, '{}'::jsonb))
    GROUP BY key, value
    ORDER BY key, cnt DESC
  `);
  const provRows = (provenanceStats as any).rows || provenanceStats;
  const byField: Record<string, Array<{ source: string; cnt: number }>> = {};
  for (const r of provRows) {
    (byField[r.field] ||= []).push({ source: r.source, cnt: Number(r.cnt) });
  }
  for (const [field, sources] of Object.entries(byField)) {
    const parts = sources.map((s) => `${s.source}=${s.cnt}`).join(", ");
    console.log(`  ${field.padEnd(28)}  ${parts}`);
  }

  // === 报告 c: 失败 journal 列表 ===
  if (failedList.length > 0) {
    console.log(`\n=== c) 失败 journal 列表 (${failedList.length}) ===`);
    failedList.forEach((f) => console.log(`  ${f.id}  ${f.name}: ${f.reason}`));
  }

  // 防 unused (journalEnrichmentLog 已被 sql raw 用)
  void journalEnrichmentLog;

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
