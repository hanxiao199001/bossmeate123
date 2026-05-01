/**
 * B.4-1: CSCD + 北大核心目录 ingest（一次性脚本，幂等）。
 *
 * 用法：
 *   pnpm --filter @bossmate/server ingest:cscd-pku [-- --dry-run]
 *
 * 行为：按 ISSN 匹配 journals 表（多租户全量更新）+ COALESCE 不覆盖已有值。
 * 扩展：admin 在 cscd-pku-mapping.ts 加 ISSN 行，重跑即可。
 */
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { CSCD_PKU_MAPPING, type CscdPkuMappingFile } from "../data/cscd-pku-mapping.js";

const VALID_CSCD = new Set(["核心库", "扩展库"]);
const VALID_PKU = new Set(["北大核心"]);

export interface IngestStats {
  totalMappings: number;
  matched: number;
  updated: number;
  unmatched: string[];
}

/** 校验 mapping enum 值（防止 TS 模块被手工编辑后 schema drift）。 */
export function validateMapping(mapping: CscdPkuMappingFile): void {
  for (const [issn, entry] of Object.entries(mapping.mappings)) {
    if (entry.cscdLevel && !VALID_CSCD.has(entry.cscdLevel)) {
      throw new Error(`非法 cscdLevel="${entry.cscdLevel}" (issn=${issn})，仅允许 核心库 / 扩展库`);
    }
    if (entry.pkuCoreLevel && !VALID_PKU.has(entry.pkuCoreLevel)) {
      throw new Error(`非法 pkuCoreLevel="${entry.pkuCoreLevel}" (issn=${issn})，仅允许 北大核心`);
    }
  }
}

export async function ingest(client: pg.Client, mapping: CscdPkuMappingFile, dryRun = false): Promise<IngestStats> {
  validateMapping(mapping);
  const entries = Object.entries(mapping.mappings);
  const stats: IngestStats = {
    totalMappings: entries.length,
    matched: 0,
    updated: 0,
    unmatched: [],
  };

  for (const [issn, entry] of entries) {
    const matchRes = await client.query<{ id: string }>(
      "SELECT id FROM journals WHERE issn = $1",
      [issn],
    );
    if (matchRes.rowCount === 0) {
      stats.unmatched.push(issn);
      continue;
    }
    stats.matched += matchRes.rowCount ?? 0;
    if (dryRun) continue;

    const updateRes = await client.query(
      `UPDATE journals
       SET cscd_level = COALESCE($1, cscd_level),
           pku_core_level = COALESCE($2, pku_core_level),
           updated_at = NOW()
       WHERE issn = $3`,
      [entry.cscdLevel ?? null, entry.pkuCoreLevel ?? null, issn],
    );
    stats.updated += updateRes.rowCount ?? 0;
  }
  return stats;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) logger.info("🔎 dry-run：只统计 ISSN 命中数，不写入");
  else logger.info("🚀 开始 ingest CSCD + 北大核心目录...");

  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  try {
    await client.connect();
    const stats = await ingest(client, CSCD_PKU_MAPPING, dryRun);
    logger.info(
      { totalMappings: stats.totalMappings, matched: stats.matched, updated: stats.updated, unmatchedCount: stats.unmatched.length },
      dryRun ? "✅ dry-run 完成" : "✅ ingest 完成",
    );
    if (stats.unmatched.length > 0) {
      logger.warn({ unmatched: stats.unmatched.slice(0, 20) }, "⚠️ 以下 ISSN 在 journals 表无匹配（前 20 条）");
    }
  } catch (err) {
    logger.fatal({ err }, "❌ ingest 失败");
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
