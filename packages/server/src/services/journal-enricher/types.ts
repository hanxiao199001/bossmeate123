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

/** Scimago Top 5 国内/全球高产机构（B.2.1.B） */
export interface TopInstitutionRow {
  name: string;
  paperCount?: number;
  percentile?: number;
  country?: string;
}

export interface PublicationStatsShape {
  frequency?: string;
  annualVolumeHistory?: AnnualVolumeRow[];
  topInstitutions?: TopInstitutionRow[]; // B.2.1.B Scimago Top 5
  lastUpdatedAt: string;
}

export interface PublicationCostsShape {
  apc?: number;
  currency?: string;
  openAccess?: boolean;
  fastTrack?: boolean;
  /**
   * 数据来源：
   *  - doaj：OA 权威（含 has_apc + max[].price）
   *  - openalex：B.2.1.B.2 主路径，apc_usd 直拉（hybrid OA 也覆盖）
   *  - journal_apc_field：DB 已有 apcFee 字段兜底
   *  - journal_website_llm：B.2.1.B stealth + LLM 抽（dormant，server IP CF 屏蔽）
   */
  source?: "doaj" | "openalex" | "journal_apc_field" | "journal_website_llm";
  lastUpdatedAt: string;
}

/** 收稿范围分类（B.2.1.B） */
export interface ScopeCategory {
  title: string;
  description?: string;
}

// ============ B.2.2 字段 ============

export interface CitingJournalRow {
  /** 引用方期刊名 */
  name: string;
  /** 引用次数 */
  count: number;
  /** 占 top-N 总和的百分比（已 0-100 整数） */
  percent?: number;
  /** OpenAlex source ID（对调试/去重有用，可省） */
  openAlexId?: string;
}

export interface CitingJournalsTop10Shape {
  topJournals: CitingJournalRow[];
  /** 自引率 0-1 区间小数（journal cites itself / total citing samples） */
  selfCitationRate?: number;
  /**
   * 自引率置信度：
   *  - low：top-N=100 paper sample（COVID/年代偏差，task #50 升级 medium）
   *  - medium：分年随机抽样
   *  - high：全量 work 聚合（理论上限）
   */
  selfCitationConfidence?: "low" | "medium" | "high";
  totalCitations?: number;
  lastUpdatedAt: string;
}

export interface CarYearRow {
  year: number;
  /** 0-1 区间小数（CN-affiliated papers / total papers in year） */
  carIndex: number;
}

export interface CarIndexHistoryShape {
  data: CarYearRow[];
  /** low / mid / high — 综合 fenqubiao 预警信号 + CAR latest year 阈值 */
  riskLevel: "low" | "mid" | "high";
  /** 是否在中科院预警名单（任一 5 年版本命中） */
  isWarningListed?: boolean;
  lastUpdatedAt: string;
}

export interface ScopeDetailsShape {
  categories?: ScopeCategory[];
  articleTypes?: string[];
  submissionNote?: string;
  /** 学科分布 percent，0-100 区间 */
  subjectDistribution?: Array<{ subject: string; percent: number }>;
  /** journal_website_llm = PR #34 LLM 路径（dormant）；openalex = B.2.1.B.2 主路径 */
  source?: "journal_website_llm" | "openalex";
  lastUpdatedAt: string;
}

/**
 * 单期刊 enrichment 结果。orchestrator 返回这个 + 写 metadata.enrichmentLog
 */
// 7-02: LetPub 本条抓取分类 — 断路器只对 "blocked"(真反爬:HTTP异常/超时/异常页) 计数;
//   "not_found"(正常返回页面但无匹配=自然查无) 不计、可继续; "skipped"(ENRICH_SKIP_LETPUB) 完全不计。
export type LetpubOutcomeKind = "ok" | "not_found" | "blocked" | "skipped";

export interface EnrichmentResult {
  journalId: string;
  startedAt: string;     // ISO
  completedAt: string;   // ISO
  durationMs: number;
  successFields: string[]; // 成功 set 的字段名（DB 列名）
  failedFields: string[];
  errors: Record<string, string>;
  letpubOutcome?: LetpubOutcomeKind; // 7-02: 本条 LetPub 抓取分类 (断路器据此分级计数)
  fieldsSummary: {
    if_history: boolean;
    jcr_full: boolean;
    publication_stats: boolean;
    publication_costs: boolean;
    scope_details: boolean;
    citing_journals_top10: boolean;
    car_index_history: boolean;
    recommendation_score: boolean;
  };
}

export interface EnrichOptions {
  /** 6-21: 抓期刊官网(Jina)→LLM 抽收稿范围。仅 reverify/refresh cron 开启, 避开生成热路径 */
  includeWebsiteScope?: boolean;
  /** 跳过 LetPub（调试用） */
  skipLetpub?: boolean;
  /** 跳过 DOAJ（调试用） */
  skipDoaj?: boolean;
  /** 跳过 OpenAlex（B.2.1.B.2；调试或 CI 用） */
  skipOpenAlex?: boolean;
  /** 跳过 fenqubiao 预警名单（B.2.2；调试或 redis 不可用时） */
  skipFenqubiao?: boolean;
  /** 跳过 Scimago + 期刊官网 stealth 抓取（B.2.1.B；现 dormant，仅作 fallback flag 保留） */
  skipStealth?: boolean;
  /** 跳过万方期刊详情（B.4-2；调试或 100 条灰度未放量时强制 skip） */
  skipWanfang?: boolean;
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
