/**
 * PR #176 — 离线 batch ingest: 从 OpenAlex API 拉 top N 期刊入 journals 表.
 *
 * 用法 (prod):
 *   ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/expand-journals-pool.js --count=500'
 *
 * 后台异步跑 (~30-45 分钟):
 *   nohup node dist/scripts/expand-journals-pool.js --count=500 \
 *     > /tmp/expand-pool-$(date +%s).log 2>&1 &
 *
 * 行为:
 *   1. OpenAlex /sources API 拿 top N 期刊 (按 cited_by_count desc)
 *   2. dedup: 跳过 DB 已有 ISSN
 *   3. 新期刊入 journals 表 (confidence=60, dataSource='openalex_ingest')
 *   4. 异步跑 enrichJournal (5 秒/次节流)
 *   5. 输出报告: 入库数 / 失败列表 / 各学科分布
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql } from "drizzle-orm";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { logger } from "../config/logger.js";

const OPENALEX_BASE = "https://api.openalex.org/sources";
const THROTTLE_MS = 5000; // 5s per enrich call
const PAGE_SIZE = 200; // OpenAlex max per_page

export interface OpenAlexSource {
  id: string;
  display_name: string;
  issn_l: string | null;
  issn: string[] | null;
  type: string;
  cited_by_count: number;
  works_count: number;
  homepage_url: string | null;
  // PR #179: x_concepts 已被 OpenAlex 废弃, topics 是新字段
  x_concepts: Array<{ display_name: string; level: number; score: number }>;
  topics?: Array<{
    display_name: string;
    subfield?: { display_name: string };
    field?: { display_name: string };
    domain?: { display_name: string };
  }>;
}

/**
 * PR #179 fix: 从 OpenAlex source 推断学科.
 * 优先级: topics[0].field > topics[0].domain > x_concepts (已废弃 fallback)
 */
export function inferDiscipline(source: OpenAlexSource): string | null {
  // 优先级 1: topics (新 API, x_concepts 已废弃)
  const topic = source.topics?.[0];
  if (topic) {
    const field = topic.field?.display_name || topic.domain?.display_name || "";
    const mapped = mapToDiscipline(field);
    if (mapped) return mapped;
  }

  // 优先级 2: x_concepts (旧 API fallback)
  const top = (source.x_concepts || []).filter(c => c.level <= 1).sort((a, b) => b.score - a.score)[0];
  if (top) {
    const mapped = mapToDiscipline(top.display_name);
    if (mapped) return mapped;
  }

  return "multidisciplinary";
}

function mapToDiscipline(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.includes("medicine") || lower.includes("health") || lower.includes("clinical") || lower.includes("nursing") || lower.includes("pharmacol")) return "medicine";
  if (lower.includes("biolog") || lower.includes("biochem") || lower.includes("genetics") || lower.includes("ecology") || lower.includes("life science")) return "biology";
  if (lower.includes("engineer") || lower.includes("material") || lower.includes("energy")) return "engineering";
  if (lower.includes("computer") || lower.includes("information") || lower.includes("artificial")) return "computer";
  if (lower.includes("chemistry") || lower.includes("chemical")) return "chemistry";
  if (lower.includes("physics") || lower.includes("astrono") || lower.includes("math")) return "physics";
  if (lower.includes("psychology") || lower.includes("psychiatr") || lower.includes("neurosci")) return "psychology";
  if (lower.includes("education") || lower.includes("pedagog")) return "education";
  if (lower.includes("economic") || lower.includes("finance") || lower.includes("business") || lower.includes("management") || lower.includes("account")) return "economics";
  if (lower.includes("social") || lower.includes("sociolog") || lower.includes("political") || lower.includes("communi")) return "economics";
  if (lower.includes("agriculture") || lower.includes("plant") || lower.includes("animal") || lower.includes("food") || lower.includes("veterina")) return "agriculture";
  if (lower.includes("environ") || lower.includes("earth") || lower.includes("geolog") || lower.includes("climate")) return "environment";
  if (lower.includes("law") || lower.includes("legal") || lower.includes("criminol")) return "law";
  return null;
}

// PR #178: export 给 refresh-journals-pool 复用
export async function fetchOpenAlexSources(count: number): Promise<OpenAlexSource[]> {
  const all: OpenAlexSource[] = [];
  let cursor = "*";
  while (all.length < count) {
    const perPage = Math.min(PAGE_SIZE, count - all.length);
    const url = `${OPENALEX_BASE}?filter=type:journal&sort=cited_by_count:desc&per_page=${perPage}&cursor=${cursor}&mailto=bossmate@example.com`;
    console.log(`[openalex] fetching page (have ${all.length}/${count})...`);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[openalex] HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
      break;
    }
    const data = await resp.json() as { results: OpenAlexSource[]; meta: { next_cursor: string } };
    if (!data.results || data.results.length === 0) break;
    all.push(...data.results);
    cursor = data.meta.next_cursor;
    if (!cursor) break;
    // OpenAlex 允许 100 req/s, 但我们保守点
    await new Promise(r => setTimeout(r, 200));
  }
  return all.slice(0, count);
}

async function main() {
  const countArg = process.argv.find(a => a.startsWith("--count="));
  const count = countArg ? parseInt(countArg.split("=")[1], 10) : 500;
  console.log(`[expand-pool] 目标: ${count} 期刊`);

  // 1. 拉 OpenAlex
  const sources = await fetchOpenAlexSources(count);
  console.log(`[expand-pool] OpenAlex 返回 ${sources.length} 个 sources`);

  // 2. 查 DB 现有 ISSN
  const existingRows = await db.select({ issn: journals.issn }).from(journals).where(sql`issn IS NOT NULL`);
  const existingIssns = new Set(existingRows.map(r => r.issn?.trim()).filter(Boolean));
  console.log(`[expand-pool] DB 已有 ${existingIssns.size} 个 ISSN`);

  // 3. 过滤 + 入库
  let inserted = 0;
  let skipped = 0;
  let enriched = 0;
  let enrichFailed = 0;
  const newJournalIds: string[] = [];

  for (const s of sources) {
    // 取 ISSN-L 或第一个 ISSN
    const issn = s.issn_l || s.issn?.[0] || null;
    if (!issn || existingIssns.has(issn)) {
      skipped++;
      continue;
    }
    existingIssns.add(issn); // 防同 batch 重复

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

      if (row) {
        newJournalIds.push(row.id);
        inserted++;
      } else {
        skipped++; // conflict (e.g. name collision)
      }
    } catch (err) {
      console.error(`[expand-pool] INSERT 失败: ${s.display_name}`, err);
      skipped++;
    }
  }

  console.log(`[expand-pool] 入库 ${inserted}, 跳过 ${skipped}`);

  // 4. 异步 enrich (5s 节流)
  console.log(`[expand-pool] 开始 enrich ${newJournalIds.length} 个新期刊 (预计 ${Math.ceil(newJournalIds.length * THROTTLE_MS / 60000)} 分钟)...`);

  for (let i = 0; i < newJournalIds.length; i++) {
    const jid = newJournalIds[i];
    try {
      await enrichJournal(jid);
      enriched++;
      if ((i + 1) % 10 === 0) {
        console.log(`[expand-pool] enrich progress: ${i + 1}/${newJournalIds.length} (ok=${enriched}, fail=${enrichFailed})`);
      }
    } catch (err) {
      enrichFailed++;
      console.error(`[expand-pool] enrich 失败 journal ${jid}:`, (err as Error).message);
    }
    if (i < newJournalIds.length - 1) {
      await new Promise(r => setTimeout(r, THROTTLE_MS));
    }
  }

  // 5. 报告
  const report = await db.execute(sql`
    SELECT discipline, COUNT(*) AS cnt
    FROM journals WHERE confidence >= 60
    GROUP BY discipline ORDER BY cnt DESC
  `);

  console.log("\n=== 扩池报告 ===");
  console.log(`OpenAlex 拉取: ${sources.length}`);
  console.log(`新入库: ${inserted}`);
  console.log(`已存在跳过: ${skipped}`);
  console.log(`enrich 成功: ${enriched}`);
  console.log(`enrich 失败: ${enrichFailed}`);
  console.log("\n学科分布 (confidence >= 60):");
  for (const r of (report as any).rows) {
    console.log(`  ${(r.discipline || "(null)").padEnd(15)} ${r.cnt}`);
  }

  const totalCount = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM journals WHERE confidence >= 60`);
  console.log(`\n总计 confidence >= 60: ${(totalCount as any).rows[0].cnt} 本期刊`);
  console.log("[expand-pool] 完成");
}

main().catch((err) => {
  console.error("[expand-pool] fatal:", err);
  process.exit(1);
});
