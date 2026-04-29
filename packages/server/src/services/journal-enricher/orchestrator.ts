/**
 * journal-enricher orchestrator（B.2.1.A + B.2.1.B + B.2.1.B.2 + B.2.2）
 *
 * 主入口 enrichJournal(journalId, options?)：
 *   1. 从 DB load journal
 *   2. 并行 fetch（LetPub + DOAJ + OpenAlex source + fenqubiao 预警名单）
 *   3. OpenAlex source 拿到后串行 fetch：
 *      - Top global/CN 机构（B.2.1.B.2）
 *      - citing journals 聚合 + self-cite（B.2.2）
 *      - CAR per-year（B.2.2）
 *   4. extract 字段（partial OK）：
 *      - if_history / jcr_full（LetPub）
 *      - publication_stats（LetPub + OpenAlex Top 机构 global/CN merge）
 *      - publication_costs（优先级 DOAJ > OpenAlex APC > journal.apcFee）
 *      - scope_details（OpenAlex topics → field rollup）
 *      - publisher（OpenAlex host_organization_name 仅回填 NULL，不覆盖手维值）
 *      - citing_journals_top10（B.2.2，含 self-cite + confidence）
 *      - car_index_history（B.2.2，含 fenqubiao 预警 OR 信号 → riskLevel）
 *   5. 总是算 recommendation_score
 *   6. idempotent UPDATE journals + 写 metadata.enrichmentLog（最近 3 条）
 *
 * Stealth fetcher（PR #34）保留但 dormant — 数据中心 IP CF 屏蔽，已从主路径移除。
 */

import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { fetchLetpubDetail } from "./fetchers/letpub-adapter.js";
import { fetchDoajByIssn } from "./fetchers/doaj-fetcher.js";
import {
  fetchOpenAlexJournal,
  fetchOpenAlexTopInstitutions,
  fetchOpenAlexCitingJournals,
  fetchOpenAlexCarIndex,
} from "./fetchers/openalex-fetcher.js";
import { fetchFenqubiaoWarningList } from "./fetchers/fenqubiao-fetcher.js";
import { extractIfHistory } from "./extractors/if-history-extractor.js";
import { extractJcrFull } from "./extractors/jcr-full-extractor.js";
import { extractPublicationStats } from "./extractors/publication-stats-extractor.js";
import { extractPublicationCosts } from "./extractors/publication-costs-extractor.js";
import {
  extractTopInstitutionsFromOpenAlex,
  extractScopeDetailsFromOpenAlex,
  extractPublicationCostsFromOpenAlex,
  extractPublisherFromOpenAlex,
  extractCitingJournalsTop10,
  extractCarIndexHistory,
} from "./extractors/openalex-extractor.js";
import { calculateRecommendationScore } from "./score/recommendation-score-calculator.js";
import type { EnrichmentResult, EnrichOptions, TopInstitutionRow } from "./types.js";

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

  // Step 2: parallel fetch (allSettled — 任一源失败不阻塞其他)
  // B.2.1.B.2: OpenAlex 主路径替代 stealth（数据中心 IP CF 屏蔽现实）。
  // B.2.2: + fenqubiao 预警名单（redis cache 24h，多刊批量首调一次）
  const [letpubResult, doajResult, openalexSourceResult, warningListResult] = await Promise.allSettled([
    options?.skipLetpub
      ? Promise.resolve(null)
      : fetchLetpubDetail({ journalName: selectQueryName(journal), issn: journal.issn }),
    options?.skipDoaj
      ? Promise.resolve(null)
      : fetchDoajByIssn(journal.issn),
    options?.skipOpenAlex
      ? Promise.resolve(null)
      : fetchOpenAlexJournal(journal.issn),
    options?.skipFenqubiao
      ? Promise.resolve(null)
      : fetchFenqubiaoWarningList(),
  ]);

  const letpub = letpubResult.status === "fulfilled" ? letpubResult.value : null;
  const doaj = doajResult.status === "fulfilled" ? doajResult.value : null;
  const openalex = openalexSourceResult.status === "fulfilled" ? openalexSourceResult.value : null;
  const warningList = warningListResult.status === "fulfilled" ? warningListResult.value : null;

  if (letpubResult.status === "rejected") {
    errors["_letpub_fetch"] = String(letpubResult.reason);
    logger.warn({ journalId, err: errors["_letpub_fetch"] }, "LetPub fetch rejected");
  }
  if (doajResult.status === "rejected") {
    errors["_doaj_fetch"] = String(doajResult.reason);
    logger.warn({ journalId, err: errors["_doaj_fetch"] }, "DOAJ fetch rejected");
  }
  if (openalexSourceResult.status === "rejected") {
    errors["_openalex_fetch"] = String(openalexSourceResult.reason);
    logger.warn({ journalId, err: errors["_openalex_fetch"] }, "OpenAlex fetch rejected");
  }
  if (warningListResult.status === "rejected") {
    errors["_fenqubiao_fetch"] = String(warningListResult.reason);
    logger.warn({ journalId, err: errors["_fenqubiao_fetch"] }, "fenqubiao fetch rejected");
  }

  // OpenAlex 二阶串行 fetch — 仅当 source 拿到才走
  let topInstitutions: TopInstitutionRow[] | null = null;
  let citingRaw: Awaited<ReturnType<typeof fetchOpenAlexCitingJournals>> | null = null;
  let carRaw: Awaited<ReturnType<typeof fetchOpenAlexCarIndex>> | null = null;
  if (openalex && !options?.skipOpenAlex) {
    const [globalRes, cnRes, citingRes, carRes] = await Promise.allSettled([
      fetchOpenAlexTopInstitutions(openalex.id, { limit: 5 }),
      fetchOpenAlexTopInstitutions(openalex.id, { country: "cn", limit: 5 }),
      fetchOpenAlexCitingJournals(openalex.id, { sampleSize: 100 }),
      fetchOpenAlexCarIndex(openalex.id, { years: 5 }),
    ]);
    const globalRows = globalRes.status === "fulfilled" ? globalRes.value : null;
    const cnRows = cnRes.status === "fulfilled" ? cnRes.value : null;
    const globalInst = extractTopInstitutionsFromOpenAlex(globalRows);
    const cnInst = extractTopInstitutionsFromOpenAlex(cnRows, "CN");
    const merged: TopInstitutionRow[] = [];
    const seen = new Set<string>();
    for (const r of [...(cnInst ?? []), ...(globalInst ?? [])]) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      merged.push(r);
      if (merged.length >= 8) break;
    }
    topInstitutions = merged.length > 0 ? merged : null;

    citingRaw = citingRes.status === "fulfilled" ? citingRes.value : null;
    carRaw = carRes.status === "fulfilled" ? carRes.value : null;
    if (citingRes.status === "rejected") {
      errors["_citing_fetch"] = String(citingRes.reason);
    }
    if (carRes.status === "rejected") {
      errors["_car_fetch"] = String(carRes.reason);
    }
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

  // publication_stats: LetPub annualVolume + frequency + OpenAlex Top 机构
  tryExtract("publication_stats", "publicationStats", () => extractPublicationStats({
    letpub,
    journalFrequency: journal.frequency,
    topInstitutions,
  }));

  // publication_costs: DOAJ > OpenAlex APC > journal.apcFee 兜底
  tryExtract("publication_costs", "publicationCosts", () => {
    const doajResult2 = extractPublicationCosts({ doaj, journalApcFee: null });
    if (doajResult2) return doajResult2;
    const openalexResult = extractPublicationCostsFromOpenAlex(openalex);
    if (openalexResult) return openalexResult;
    return extractPublicationCosts({ doaj: null, journalApcFee: journal.apcFee });
  });

  // scope_details: OpenAlex topics → field rollup
  tryExtract("scope_details", "scopeDetails", () => extractScopeDetailsFromOpenAlex(openalex));

  // B.2.2: citing journals top 10 + self-cite confidence
  tryExtract("citing_journals_top10", "citingJournalsTop10", () =>
    openalex ? extractCitingJournalsTop10(citingRaw, openalex.id) : null,
  );

  // B.2.2: CAR 历史 + riskLevel（融合 fenqubiao 预警名单）
  tryExtract("car_index_history", "carIndexHistory", () =>
    extractCarIndexHistory(carRaw, warningList, journal.issn),
  );

  // B.2.1.B.2: publisher 回填（仅当 DB 当前 NULL 才覆盖，避免覆盖手维值）
  if (!journal.publisher) {
    try {
      const pub = extractPublisherFromOpenAlex(openalex);
      if (pub) {
        updates.publisher = pub;
        successFields.push("publisher");
      }
    } catch (err) {
      errors["publisher"] = err instanceof Error ? err.message : String(err);
      logger.warn({ journalId, err: errors["publisher"] }, "publisher extractor failed");
    }
  }

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
      scope_details: !!updates.scopeDetails,
      citing_journals_top10: !!updates.citingJournalsTop10,
      car_index_history: !!updates.carIndexHistory,
      recommendation_score: typeof updates.recommendationScore === "number",
    },
  };

  return result;
}
