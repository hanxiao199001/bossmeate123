/**
 * journal-enricher orchestrator（B.2.1.A）
 *
 * 主入口 enrichJournal(journalId, options?)：
 *   1. 从 DB load journal
 *   2. 并行 fetch（LetPub + DOAJ），allSettled 不阻塞
 *   3. 串行 extract 每个字段，partial OK
 *   4. 总是算 recommendation_score（即便所有 fetcher 失败）
 *   5. idempotent UPDATE journals
 *   6. 写 metadata.enrichmentLog（最近 3 条）
 *
 * 不在 B.2.1.A：
 *   ❌ Scimago fetch（403 + 需 Scrapling）→ B.2.1.B
 *   ❌ 期刊官网 LLM 解析（SPA 化 + JSON parse 风险）→ B.2.1.B
 *   ❌ topInstitutions / scope_details / car_index_history / citing_journals_top10
 */

import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { fetchLetpubDetail } from "./fetchers/letpub-adapter.js";
import { fetchDoajByIssn } from "./fetchers/doaj-fetcher.js";
import { extractIfHistory } from "./extractors/if-history-extractor.js";
import { extractJcrFull } from "./extractors/jcr-full-extractor.js";
import { extractPublicationStats } from "./extractors/publication-stats-extractor.js";
import { extractPublicationCosts } from "./extractors/publication-costs-extractor.js";
import { calculateRecommendationScore } from "./score/recommendation-score-calculator.js";
import type { EnrichmentResult, EnrichOptions } from "./types.js";

/** 单条 enrichmentLog entry */
interface EnrichLogEntry {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  successFields: string[];
  failedFields: string[];
  errors: Record<string, string>;
}

const MAX_LOG_ENTRIES = 3;

/** Bug B 修：LetPub 不识别中文名（柳叶刀 → 0 results），英文优先回落中文。Exported for tests. */
export function selectQueryName(journal: { name: string; nameEn: string | null }): string {
  return journal.nameEn || journal.name;
}

type JournalUpdate = Partial<typeof journals.$inferInsert>;

export async function enrichJournal(
  journalId: string,
  options?: EnrichOptions
): Promise<EnrichmentResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Step 1: load journal
  const rows = await db.select().from(journals).where(eq(journals.id, journalId)).limit(1);
  const journal = rows[0];
  if (!journal) {
    throw new Error(`Journal not found: ${journalId}`);
  }

  const successFields: string[] = [];
  const failedFields: string[] = [];
  const errors: Record<string, string> = {};

  // Step 2: parallel fetch (allSettled — 任一源失败不阻塞另一源)
  const [letpubResult, doajResult] = await Promise.allSettled([
    options?.skipLetpub
      ? Promise.resolve(null)
      : fetchLetpubDetail({ journalName: selectQueryName(journal), issn: journal.issn }),
    options?.skipDoaj
      ? Promise.resolve(null)
      : fetchDoajByIssn(journal.issn),
  ]);

  const letpub = letpubResult.status === "fulfilled" ? letpubResult.value : null;
  const doaj = doajResult.status === "fulfilled" ? doajResult.value : null;

  if (letpubResult.status === "rejected") {
    errors["_letpub_fetch"] = String(letpubResult.reason);
    logger.warn({ journalId, err: errors["_letpub_fetch"] }, "LetPub fetch rejected");
  }
  if (doajResult.status === "rejected") {
    errors["_doaj_fetch"] = String(doajResult.reason);
    logger.warn({ journalId, err: errors["_doaj_fetch"] }, "DOAJ fetch rejected");
  }

  // Step 3: extract each field（独立 try-catch，partial OK）
  // Bug A 修：updates 用 drizzle camelCase key（snake_case 会被 drizzle 静默丢弃）
  const updates: JournalUpdate = {};

  const tryExtract = <K extends keyof JournalUpdate>(
    logName: string,
    drizzleKey: K,
    fn: () => JournalUpdate[K] | null | undefined,
  ) => {
    try {
      const value = fn();
      if (value !== null && value !== undefined) {
        updates[drizzleKey] = value;
        successFields.push(logName);
      }
      // value == null 不算失败（数据源没数据，正常）
    } catch (err) {
      failedFields.push(logName);
      errors[logName] = err instanceof Error ? err.message : String(err);
      logger.warn({ journalId, fieldName: logName, err: errors[logName] }, "extractor failed");
    }
  };

  tryExtract("if_history", "ifHistory", () => extractIfHistory(letpub));
  tryExtract("jcr_full", "jcrFull", () => extractJcrFull(letpub));
  tryExtract("publication_stats", "publicationStats", () => extractPublicationStats({
    letpub,
    journalFrequency: journal.frequency,
  }));
  tryExtract("publication_costs", "publicationCosts", () => extractPublicationCosts({
    doaj,
    journalApcFee: journal.apcFee,
  }));

  // Step 4: 总是算 score（即便所有 extractor 都没数据，基于已有 journal 字段也算）
  try {
    const score = calculateRecommendationScore({
      impactFactor: journal.impactFactor,
      jcrQuartile: journal.partition,
      carRiskLevel: null, // B.2.2 才有
      jcrFull: (updates.jcrFull as any) || null,
      publicationCosts: (updates.publicationCosts as any) || null,
    });
    updates.recommendationScore = score;
    successFields.push("recommendation_score");
  } catch (err) {
    failedFields.push("recommendation_score");
    errors["recommendation_score"] = err instanceof Error ? err.message : String(err);
  }

  // Step 5: UPDATE（idempotent，dryRun 时跳过）+ 6: 写 enrichmentLog
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  const logEntry: EnrichLogEntry = {
    startedAt,
    completedAt,
    durationMs,
    successFields,
    failedFields,
    errors,
  };

  if (!options?.dryRun) {
    // 合并 metadata.enrichmentLog（最近 3 条），不破坏其他 metadata 键
    const existingMeta = (journal.metadata as Record<string, unknown>) || {};
    const existingLog: EnrichLogEntry[] = Array.isArray(existingMeta.enrichmentLog)
      ? (existingMeta.enrichmentLog as EnrichLogEntry[])
      : [];
    const newLog = [logEntry, ...existingLog].slice(0, MAX_LOG_ENTRIES);
    const newMeta = { ...existingMeta, enrichmentLog: newLog };

    await db.update(journals)
      .set({ ...updates, metadata: newMeta, updatedAt: new Date() })
      .where(eq(journals.id, journalId));

    logger.info(
      {
        journalId,
        successFields,
        failedFields,
        durationMs,
        score: updates.recommendationScore,
      },
      "journal enriched"
    );
  } else {
    logger.info({ journalId, successFields, dryRun: true }, "journal enrich (dry-run)");
  }

  const result: EnrichmentResult = {
    journalId,
    startedAt,
    completedAt,
    durationMs,
    successFields,
    failedFields,
    errors,
    fieldsSummary: {
      if_history: !!updates.ifHistory,
      jcr_full: !!updates.jcrFull,
      publication_stats: !!updates.publicationStats,
      publication_costs: !!updates.publicationCosts,
      recommendation_score: typeof updates.recommendationScore === "number",
    },
  };

  return result;
}
