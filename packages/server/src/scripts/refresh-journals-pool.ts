/**
 * PR #178 — 月度期刊池刷新 + 异常值检测.
 *
 * 用法 (prod 手动):
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/refresh-journals-pool.js'
 *
 * 自动: scheduler.ts 每月 1 日 04:00 BJ 触发.
 *
 * Phase 1: re-enrich 现有 confidence>=60 期刊 (数据保鲜)
 * Phase 2: 加 50 新热门期刊 (复用 expand-journals-pool)
 * Phase 3: 异常值检测 (IF 跳变 / 录用率过高 / APC 异常 / 分区降级)
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, eq, gte } from "drizzle-orm";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { fetchOpenAlexSources, inferDiscipline } from "./expand-journals-pool.js";
import { logger } from "../config/logger.js";

const THROTTLE_MS = 5000;

export interface RefreshOptions {
  newCount: number;       // 新加几个热门期刊 (default 50)
  refreshExisting: boolean; // 是否 re-enrich 现有 (default true)
  throttleMs: number;     // LetPub 节流 ms
}

export interface AnomalyRecord {
  type: "IF_JUMP" | "HIGH_ACCEPTANCE" | "HIGH_APC" | "PARTITION_DROP";
  before?: string | number;
  after?: string | number;
  changePercent?: string;
  value?: number;
}

export interface RefreshResult {
  refreshed: number;
  anomalies: number;
  anomalyDetails: Array<{ journalId: string; name: string; issues: AnomalyRecord[] }>;
  newAdded: number;
  elapsedSeconds: number;
}

/**
 * 异常值检测: 对比 enrich 前后数据
 */
export function detectAnomalies(
  before: { impactFactor?: number | null; partition?: string | null },
  after: { impactFactor?: number | null; partition?: string | null; acceptanceRate?: number | null; apcFee?: number | null },
): AnomalyRecord[] | null {
  const anomalies: AnomalyRecord[] = [];

  // IF 跳变 > ±30%
  if (before.impactFactor && after.impactFactor && before.impactFactor > 0) {
    const change = Math.abs(after.impactFactor - before.impactFactor) / before.impactFactor;
    if (change > 0.30) {
      anomalies.push({
        type: "IF_JUMP",
        before: before.impactFactor,
        after: after.impactFactor,
        changePercent: (change * 100).toFixed(1),
      });
    }
  }

  // 录用率 > 60%
  if (after.acceptanceRate && after.acceptanceRate > 0.60) {
    anomalies.push({ type: "HIGH_ACCEPTANCE", value: after.acceptanceRate });
  }

  // APC > $10000
  if (after.apcFee && after.apcFee > 10000) {
    anomalies.push({ type: "HIGH_APC", value: after.apcFee });
  }

  // 分区降级 Q1 → Q3/Q4
  if (before.partition && after.partition) {
    const bNum = parseInt(before.partition.replace("Q", ""), 10);
    const aNum = parseInt(after.partition.replace("Q", ""), 10);
    if (bNum <= 1 && aNum >= 3) {
      anomalies.push({ type: "PARTITION_DROP", before: before.partition, after: after.partition });
    }
  }

  return anomalies.length > 0 ? anomalies : null;
}

export async function refreshJournalsPool(opts?: Partial<RefreshOptions>): Promise<RefreshResult> {
  const options: RefreshOptions = {
    newCount: opts?.newCount ?? 50,
    refreshExisting: opts?.refreshExisting ?? true,
    throttleMs: opts?.throttleMs ?? THROTTLE_MS,
  };

  const startedAt = Date.now();
  logger.info({ options }, "[refresh-pool] 月度刷新启动");

  let refreshed = 0;
  let anomalyCount = 0;
  const anomalyDetails: RefreshResult["anomalyDetails"] = [];

  // Phase 1: re-enrich 现有 journals
  if (options.refreshExisting) {
    const allJournals = await db
      .select({
        id: journals.id,
        name: journals.name,
        nameEn: journals.nameEn,
        impactFactor: journals.impactFactor,
        partition: journals.partition,
        acceptanceRate: journals.acceptanceRate,
        apcFee: journals.apcFee,
      })
      .from(journals)
      .where(gte(journals.confidence, 60));

    logger.info({ count: allJournals.length }, "[refresh-pool] Phase 1: re-enrich 开始");

    for (let i = 0; i < allJournals.length; i++) {
      const j = allJournals[i];
      const before = { impactFactor: j.impactFactor, partition: j.partition };

      try {
        await enrichJournal(j.id);

        // 查 enrich 后的值
        const [after] = await db
          .select({
            impactFactor: journals.impactFactor,
            partition: journals.partition,
            acceptanceRate: journals.acceptanceRate,
            apcFee: journals.apcFee,
          })
          .from(journals)
          .where(eq(journals.id, j.id))
          .limit(1);

        if (after) {
          const issues = detectAnomalies(before, after);
          if (issues) {
            anomalyCount++;
            anomalyDetails.push({ journalId: j.id, name: j.nameEn || j.name, issues });
            logger.warn({ journalId: j.id, name: j.nameEn, issues }, "[refresh-pool] 异常值检测");
          }
        }
        refreshed++;
      } catch (err) {
        logger.error({ journalId: j.id, err: (err as Error).message }, "[refresh-pool] enrich 失败");
      }

      if (i < allJournals.length - 1) {
        await new Promise(r => setTimeout(r, options.throttleMs));
      }

      if ((i + 1) % 50 === 0) {
        logger.info({ progress: `${i + 1}/${allJournals.length}`, refreshed, anomalies: anomalyCount }, "[refresh-pool] Phase 1 进度");
      }
    }

    logger.info({ refreshed, anomalies: anomalyCount }, "[refresh-pool] Phase 1 完成");
  }

  // Phase 2: 加 N 新热门期刊
  let newAdded = 0;
  if (options.newCount > 0) {
    logger.info({ newCount: options.newCount }, "[refresh-pool] Phase 2: 加新热门期刊");

    const sources = await fetchOpenAlexSources(options.newCount + 100); // 多拉 100 做 dedup buffer
    const existingRows = await db.select({ issn: journals.issn }).from(journals).where(sql`issn IS NOT NULL`);
    const existingIssns = new Set(existingRows.map(r => r.issn?.trim()).filter(Boolean));

    for (const s of sources) {
      if (newAdded >= options.newCount) break;
      const issn = s.issn_l || s.issn?.[0] || null;
      if (!issn || existingIssns.has(issn)) continue;
      existingIssns.add(issn);

      try {
        const [row] = await db.insert(journals).values({
          name: s.display_name,
          nameEn: s.display_name,
          issn,
          discipline: inferDiscipline(s),
          status: "active",
          source: "openalex",
          dataSource: "openalex_monthly_refresh",
          confidence: 60,
          website: s.homepage_url,
        }).onConflictDoNothing().returning({ id: journals.id });

        if (row) {
          await enrichJournal(row.id);
          newAdded++;
          await new Promise(r => setTimeout(r, options.throttleMs));
        }
      } catch (err) {
        logger.error({ source: s.display_name, err: (err as Error).message }, "[refresh-pool] Phase 2 单条失败");
      }
    }

    logger.info({ newAdded }, "[refresh-pool] Phase 2 完成");
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const result: RefreshResult = { refreshed, anomalies: anomalyCount, anomalyDetails, newAdded, elapsedSeconds };

  // 报告
  logger.info(result, "[refresh-pool] 月度刷新完成");
  if (anomalyDetails.length > 0) {
    console.log("\n=== 异常值列表 ===");
    for (const a of anomalyDetails) {
      console.log(`  ${a.name}: ${a.issues.map(i => `${i.type}${i.changePercent ? ` (${i.changePercent}%)` : ""}`).join(", ")}`);
    }
  }

  return result;
}

// CLI 直接跑
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("refresh-journals-pool.js")) {
  const skipRefresh = process.argv.includes("--skip-refresh");
  const newCountArg = process.argv.find(a => a.startsWith("--new-count="));
  const newCount = newCountArg ? parseInt(newCountArg.split("=")[1], 10) : 50;

  refreshJournalsPool({ newCount, refreshExisting: !skipRefresh })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error("[refresh-pool] fatal:", err);
      process.exit(1);
    });
}
