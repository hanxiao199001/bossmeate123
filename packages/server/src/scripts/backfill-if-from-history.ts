/**
 * 5-20 PR #194 — 从 if_history 提取最新年 IF 填 impact_factor 单值 (纯 DB, 不碰网络).
 *
 * 背景: enrich 全量跑完后 if_history 覆盖 84.8% (4251 本), 但 impact_factor 单值仍 1% (48 本).
 *   enricher 写了 if_history 数组, 没从中提取最新年 IF 写 impact_factor.
 *   而标题(无IF不放IF风格)/SCI过滤(wosLevel OR IF)/卡片显示 都依赖 impact_factor 单值.
 *
 * 用法 (prod):
 *   ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && node dist/scripts/backfill-if-from-history.js'
 *
 * 行为: 遍历 if_history 非空 + impact_factor 空的期刊, 取 if_history.data 最新年 IF 写 impact_factor.
 *   纯 DB 操作, 不爬 LetPub/不耗代理. 已有 impact_factor 的不覆盖 (保留 48 本老期刊真值).
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, isNotNull } from "drizzle-orm";
import { logger } from "../config/logger.js";

/** 从 if_history jsonb 取最新年 IF. 兼容 {data:[{year,if}]} / [{year,value}] 两种结构. */
function latestIF(ifHistory: unknown): number | null {
  if (!ifHistory) return null;
  const raw = ifHistory as { data?: unknown } | unknown[];
  const data = Array.isArray(raw) ? raw : (Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : null);
  if (!Array.isArray(data) || data.length === 0) return null;
  let best: { year: number; if: number } | null = null;
  for (const row of data as Array<{ year?: number; if?: number; value?: number }>) {
    const yr = row.year;
    const v = row.if ?? row.value;
    if (typeof yr === "number" && typeof v === "number" && v > 0) {
      if (!best || yr > best.year) best = { year: yr, if: v };
    }
  }
  return best ? best.if : null;
}

async function main() {
  // 只补 impact_factor 空 + if_history 非空的 (不覆盖已有真值)
  // PR #197 (5-21): 以 LetPub 为准 — 对所有有 if_history(LetPub) 的期刊, 用最新年 IF 覆盖 impact_factor.
  //   不再只补 NULL: OpenAlex ingest 填的近似 IF 也要被 LetPub 真值覆盖修正.
  const targets = await db
    .select({ id: journals.id, name: journals.name, ifHistory: journals.ifHistory })
    .from(journals)
    .where(isNotNull(journals.ifHistory));

  console.log(`[backfill-if] ${targets.length} 本有 if_history(LetPub), 用最新年 IF 覆盖 impact_factor (以 LetPub 为准)`);

  let updated = 0;
  let noValid = 0;
  for (const j of targets) {
    const iff = latestIF(j.ifHistory);
    if (iff == null) { noValid += 1; continue; }
    try {
      // PR #209 (5-22): 覆盖 IF 时同步标记来源 — JSONB 合并只加 impactFactor 键, 不动其它已有来源.
      //   修历史欠账: 之前 backfill 只写值没写 provenance, 导致"IF 来源分布"查出来全是 NULL.
      await db.update(journals).set({
        impactFactor: iff,
        fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"impactFactor":"letpub"}'::jsonb`,
      }).where(sql`${journals.id} = ${j.id}`);
      updated += 1;
    } catch (err) {
      logger.warn({ err: String(err), name: j.name }, "[backfill-if] update 失败");
    }
  }

  // 报告
  const cov = await db.execute(sql`
    SELECT COUNT(*) AS total, COUNT(impact_factor) AS has_if
    FROM journals WHERE confidence >= 60
  `);
  const row = (cov as unknown as { rows: Array<{ total: string; has_if: string }> }).rows[0];

  console.log(`\n========== backfill-if 报告 ==========`);
  console.log(`处理:        ${targets.length}`);
  console.log(`成功填 IF:   ${updated}`);
  console.log(`if_history 无有效年份: ${noValid}`);
  console.log(`当前 IF 覆盖 (conf>=60): ${row?.has_if}/${row?.total}`);
  console.log(`======================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[backfill-if] 致命错误");
  process.exit(1);
});
