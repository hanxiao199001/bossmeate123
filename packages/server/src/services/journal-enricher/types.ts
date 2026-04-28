/**
 * journal-enricher 类型定义（B.2.1.A）
 *
 * 这些 jsonb shape 与 schema.ts 的字段（B.1 + B.1.1 已落 main）严格对齐，
 * 也跟 shunshi-style 模板（A 补丁 23 区块）的 type guard 对齐。
 *
 * 不在 B.2.1.A 范围（保留字段名占位但本 PR 不写入）：
 *   - publication_stats.topInstitutions （B.2.1.B Scrapling/Scimago）
 *   - scope_details                     （B.2.1.B Playwright + LLM）
 *   - publication_costs (非 OA 期刊)    （B.2.1.B Playwright + LLM）
 *   - car_index_history                 （B.2.2 CAR 平台调研）
 *   - citing_journals_top10             （B.2.2 Scimago Citers）
 */

export interface IfHistoryRow {
  year: number;
  if: number;
}

export interface IfHistoryShape {
  data: IfHistoryRow[];
  predicted?: { year: number; if: number; source?: string };
  lastUpdatedAt: string; // ISO date
}

export interface JcrSubjectEntry {
  subject: string;
  zone?: string;     // "Q1" | "Q2" | "Q3" | "Q4"
  rank?: string;     // "6/98"
  database?: string; // "SCIE" | "SSCI" 等
}

export interface JcrFullShape {
  wosLevel?: string;            // "SCIE" | "SSCI" | "SCI" | "ESCI"
  jifSubjects?: JcrSubjectEntry[];
  jciSubjects?: JcrSubjectEntry[];
  isTopJournal?: boolean;
  isReviewJournal?: boolean;
  lastUpdatedAt: string;
}

export interface AnnualVolumeRow {
  year: number;
  count: number;
}

export interface PublicationStatsShape {
  frequency?: string;
  annualVolumeHistory?: AnnualVolumeRow[];
  // topInstitutions: 不在 B.2.1.A，B.2.1.B 加
  lastUpdatedAt: string;
}

export interface PublicationCostsShape {
  apc?: number;
  currency?: string;
  openAccess?: boolean;
  fastTrack?: boolean;
  source?: "doaj" | "journal_apc_field"; // 标记数据来源便于排查
  lastUpdatedAt: string;
}

/**
 * 单期刊 enrichment 结果。orchestrator 返回这个 + 写 metadata.enrichmentLog
 */
export interface EnrichmentResult {
  journalId: string;
  startedAt: string;     // ISO
  completedAt: string;   // ISO
  durationMs: number;
  successFields: string[]; // 成功 set 的字段名（DB 列名）
  failedFields: string[];
  errors: Record<string, string>;
  fieldsSummary: {
    if_history: boolean;
    jcr_full: boolean;
    publication_stats: boolean;
    publication_costs: boolean;
    recommendation_score: boolean;
  };
}

export interface EnrichOptions {
  /** 跳过 LetPub（调试用） */
  skipLetpub?: boolean;
  /** 跳过 DOAJ（调试用） */
  skipDoaj?: boolean;
  /** dry-run：算结果但不 UPDATE DB（仅 orchestrator 直调时用） */
  dryRun?: boolean;
}

/**
 * DOAJ API 返回的 OA 期刊记录（仅取 enricher 关心字段）
 * 完整 schema 见 https://doaj.org/api/docs
 */
export interface DoajJournalRecord {
  id: string;
  bibjson: {
    title?: string;
    eissn?: string;
    pissn?: string;
    apc?: {
      has_apc?: boolean;
      max?: Array<{ price: number; currency: string }>;
    };
    publication_time_weeks?: number;
    publisher?: { name?: string; country?: string };
  };
}
