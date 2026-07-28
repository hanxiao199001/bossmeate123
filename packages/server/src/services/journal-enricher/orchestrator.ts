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
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { journals, journalEnrichmentLog } from "../../models/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../../config/logger.js";

// 5-23 PR #165 — 观察日志 per-source 计时辅助 (0 风险, 不改 fetcher 逻辑)
async function timed<T>(label: string, p: Promise<T> | T): Promise<{ value: T; ms: number; status: "success" | "failed" | "timeout"; error?: string }> {
  const t0 = Date.now();
  try {
    const value = await p;
    return { value, ms: Date.now() - t0, status: "success" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout|aborted|ETIMEDOUT|signal/i.test(msg);
    return { value: null as unknown as T, ms: Date.now() - t0, status: isTimeout ? "timeout" : "failed", error: msg };
  }
}
import { fetchLetpubDetail } from "./fetchers/letpub-adapter.js";
import { fetchDoajByIssn } from "./fetchers/doaj-fetcher.js";
// PR #107 / PR #166: crossref 主源 (scimago 5-23 PR #166 砍掉 — Cloudflare 拉黑 0% 命中)
import { fetchCrossrefByIssn } from "./fetchers/crossref-fetcher.js";
import { computeTrust } from "./trust-score.js";
import {
  fetchOpenAlexJournal,
  fetchOpenAlexTopInstitutions,
  fetchOpenAlexCitingJournals,
  fetchOpenAlexCarIndex,
} from "./fetchers/openalex-fetcher.js";
import { fetchFenqubiaoWarningList } from "./fetchers/fenqubiao-fetcher.js";
import { fetchWanfangPeriodical } from "./fetchers/wanfang-fetcher.js";
import { extractWanfangPeriodical, type WanfangExtractedShape } from "./extractors/wanfang-extractor.js";
import { extractIfHistory } from "./extractors/if-history-extractor.js";
import { extractJcrFull } from "./extractors/jcr-full-extractor.js";
import { extractPublicationStats } from "./extractors/publication-stats-extractor.js";
import { extractPublicationCosts } from "./extractors/publication-costs-extractor.js";
import {
  extractTopInstitutionsFromOpenAlex,
  extractScopeDetailsFromOpenAlex,
  extractPublicationCostsFromOpenAlex,
  extractPublisherFromOpenAlex,
  extractWebsiteFromOpenAlex,
  extractCitingJournalsTop10,
  extractCarIndexHistory,
} from "./extractors/openalex-extractor.js";
import { calculateRecommendationScore } from "./score/recommendation-score-calculator.js";
import type { EnrichmentResult, EnrichOptions, TopInstitutionRow, LetpubOutcomeKind } from "./types.js";

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
  // B.4-2: + 万方期刊详情（仅当 metadata.wanfang.perioId admin 预填时触发）
  const wanfangPerioId = ((journal.metadata as Record<string, any> | null)?.wanfang?.perioId ?? null) as string | null;
  // PR #107 / PR #166: 6 源 (letpub/doaj/openalex/fenqubiao/wanfang/crossref) — scimago 已砍
  // PR #165: 用 timed() 包每源, 收集 per-source duration + status 给 journal_enrichment_log
  // PR #260: 全局熔断 — ENRICH_SKIP_LETPUB=true 时跳过 LetPub (反爬封 IP 时无需重新部署即可止血)
  const skipLetpub = options?.skipLetpub || process.env.ENRICH_SKIP_LETPUB === "true";
  const [letpubTimed, doajTimed, openalexTimed, fenqubiaoTimed, wanfangTimed, crossrefTimed] = await Promise.all([
    timed("letpub", skipLetpub ? Promise.resolve(null) : fetchLetpubDetail({ journalName: selectQueryName(journal), issn: journal.issn })),
    timed("doaj", options?.skipDoaj ? Promise.resolve(null) : fetchDoajByIssn(journal.issn)),
    timed("openalex", options?.skipOpenAlex ? Promise.resolve(null) : fetchOpenAlexJournal(journal.issn)),
    timed("fenqubiao", options?.skipFenqubiao ? Promise.resolve(null) : fetchFenqubiaoWarningList()),
    timed("wanfang", options?.skipWanfang || !wanfangPerioId ? Promise.resolve(null) : fetchWanfangPeriodical({ perioId: wanfangPerioId, issn: journal.issn, nameZh: journal.name })),
    timed("crossref", fetchCrossrefByIssn(journal.issn)),
  ]);

  // 7-02: letpubTimed.value 现在是分类 outcome(skip 时为 null)。detail 供下游 extractor, outcome 供断路器分级。
  const letpubOutcomeVal = letpubTimed.value; // LetPubFetchOutcome | null
  const letpub = (letpubOutcomeVal && letpubOutcomeVal.kind === "ok") ? letpubOutcomeVal.detail : null;
  const letpubOutcome: LetpubOutcomeKind =
    skipLetpub ? "skipped"
      : letpubTimed.status !== "success" ? "blocked"
        : (letpubOutcomeVal?.kind ?? "blocked");
  const doaj = doajTimed.value;
  const openalex = openalexTimed.value;
  const warningList = fenqubiaoTimed.value;
  const wanfangRaw = wanfangTimed.value;
  const crossref = crossrefTimed.value;
  // 老 *Result 别名保 backward compat (errors block 用)
  const letpubResult = { status: letpubTimed.status === "success" ? "fulfilled" : "rejected", reason: letpubTimed.error } as { status: string; reason?: string };
  const doajResult = { status: doajTimed.status === "success" ? "fulfilled" : "rejected", reason: doajTimed.error } as { status: string; reason?: string };
  const openalexSourceResult = { status: openalexTimed.status === "success" ? "fulfilled" : "rejected", reason: openalexTimed.error } as { status: string; reason?: string };
  const warningListResult = { status: fenqubiaoTimed.status === "success" ? "fulfilled" : "rejected", reason: fenqubiaoTimed.error } as { status: string; reason?: string };

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

  // PR #165a: 真实字段来源追踪 (vs trust-score 的默认 mapping). 后面 merge 入 fieldProvenance.
  const realProvenance: Record<string, string> = {};

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
  if (updates.ifHistory) realProvenance.ifHistory = "letpub";

  tryExtract("jcr_full", "jcrFull", () => extractJcrFull(letpub));
  if (updates.jcrFull) realProvenance.jcrFull = "letpub";

  // PR #190 (5-20): 存 LetPub 封面 URL (letpub-detail-scraper.parseCoverImage 提取, 之前漏存)
  tryExtract("cover_image_url", "coverImageUrl", () => (letpub as { coverImageUrl?: string | null } | null)?.coverImageUrl ?? null);
  if (updates.coverImageUrl) realProvenance.coverImageUrl = "letpub";

  // PR #194 (5-20): 从 LetPub if_history 取最新年 IF 写 impact_factor 单值 (标题/SCI过滤/显示依赖单值, 非数组)
  tryExtract("impact_factor", "impactFactor", () => {
    const hist = (letpub as { ifHistory?: Array<{ year?: number; value?: number }> } | null)?.ifHistory;
    if (!Array.isArray(hist) || hist.length === 0) return null;
    const valid = hist.filter((r) => typeof r.year === "number" && typeof r.value === "number" && (r.value as number) > 0);
    if (valid.length === 0) return null;
    valid.sort((a, b) => (b.year as number) - (a.year as number));
    return valid[0].value ?? null;
  });
  if (updates.impactFactor) realProvenance.impactFactor = "letpub";

  // publication_stats: LetPub annualVolume + frequency + OpenAlex Top 机构 (混合源)
  tryExtract("publication_stats", "publicationStats", () => extractPublicationStats({
    letpub,
    journalFrequency: journal.frequency,
    topInstitutions,
  }));
  if (updates.publicationStats) realProvenance.publicationStats = "letpub+openalex";

  // publication_costs: DOAJ > OpenAlex APC > journal.apcFee 兜底 — 跟踪具体哪一源命中
  tryExtract("publication_costs", "publicationCosts", () => {
    const doajResult2 = extractPublicationCosts({ doaj, journalApcFee: null });
    if (doajResult2) { realProvenance.publicationCosts = "doaj"; return doajResult2; }
    const openalexResult = extractPublicationCostsFromOpenAlex(openalex);
    if (openalexResult) { realProvenance.publicationCosts = "openalex"; return openalexResult; }
    const fallback = extractPublicationCosts({ doaj: null, journalApcFee: journal.apcFee });
    if (fallback) realProvenance.publicationCosts = "journal_apcFee";
    return fallback;
  });

  // PR #210 (5-22): 停抓 OpenAlex 派生不准数据 — scope_details(concepts噪声)/citing(引用)/CAR
  //   三者准确度极低 (老韩定调), 展示/prompt 已全砍, 这里一并停止抓取/写库, 省 OpenAlex 调用.
  //   保留 publisher/website 事实型回填 (见下方). 待 ablesci/jcarindex 权威源到位再议 CAR.
  // tryExtract("scope_details", "scopeDetails", () => extractScopeDetailsFromOpenAlex(openalex));
  // tryExtract("citing_journals_top10", "citingJournalsTop10", () => openalex ? extractCitingJournalsTop10(citingRaw, openalex.id) : null);
  // tryExtract("car_index_history", "carIndexHistory", () => extractCarIndexHistory(carRaw, warningList, journal.issn));

  // B.4-2: 万方 extract（partial OK）+ cscd / pku 互补（仅 NULL 才填，不覆盖 B.4-1 静态权威）
  let wanfangData: WanfangExtractedShape | null = null;
  try {
    wanfangData = extractWanfangPeriodical(wanfangRaw);
    if (wanfangData) successFields.push("wanfang");
  } catch (err) {
    failedFields.push("wanfang");
    errors["wanfang"] = err instanceof Error ? err.message : String(err);
  }
  // 7-28 (③d) 为什么这里**不**顺手回写 catalogs（"定义裂缝刊"的成因，评估后决定不做）:
  //   ① 病已经被 journal_kind 生成列治住 —— 只有 cscd_level/pku_core_level 而 catalogs 为空的刊
  //      现在稳定归类为 'cn'，国内槽位可见、可信门槛也认它，裂缝本身不再致病（这条因此降级）。
  //   ② catalogs 非空即"有目录"，merge 进去等于用**动态抓取值**改写一个原本由静态权威目录
  //      (B.4-1 北大核心总览 / CSCD 目录)灌进来的列；而 catalogs 直接驱动对客文案的身份徽章
  //      (renderDomesticCredentialBlock / article-skill idTags / title-generator idTags)——
  //      写错一个 'pku-core' 就是对客户宣称"这是北大核心"，属信任事故，不是数据瑕疵。
  //   ③ 供数源当前就是坏的: backlog-B —— wanfang-fetcher 的 detail URL 仍是过时的
  //      `/Periodical/Detail/{id}`（现网是 `/Periodical/{id}`），orchestrator 这条万方详情链路
  //      基本取不到数据。从一个已知失效的源回写权威列，正是 7-25 那次事故的配方
  //      （"一次抓取失败"被升级成"永久数据污染 + 校验体系失效"）。
  //   要做的话前置条件: 先修 backlog-B 的 URL、用真实刊逐字段验证 cscdLevelDynamic/pkuCoreDynamic
  //   的准确率，再走"只追加不删除 + 只在本轮真写了等级列时才追加对应 tag"的加法式 merge。
  if (wanfangData?.cscdLevelDynamic && !journal.cscdLevel) {
    updates.cscdLevel = wanfangData.cscdLevelDynamic;
    successFields.push("cscd_level (wanfang dynamic)");
    realProvenance.cscdLevel = "wanfang";
  }
  if (wanfangData?.pkuCoreDynamic && !journal.pkuCoreLevel) {
    updates.pkuCoreLevel = wanfangData.pkuCoreDynamic;
    successFields.push("pku_core_level (wanfang dynamic)");
    realProvenance.pkuCoreLevel = "wanfang";
  }
  // task#104 阶段2: 万方"中信所核心影响因子"→ composite_impact_factor 列（国内刊影响力指标）。
  //   仅当 DB 当前 NULL 才填（不覆盖手维/知网值），provenance=wanfang。
  //   守"数字必须有源"：这是国内复合 IF，绝不并入 impact_factor（那会让 hasWosData 误判成国外刊）。
  if (typeof wanfangData?.cnImpactFactor === "number" && journal.compositeImpactFactor == null) {
    updates.compositeImpactFactor = wanfangData.cnImpactFactor;
    successFields.push("composite_impact_factor (wanfang)");
    realProvenance.compositeImpactFactor = "wanfang";
  }

  // B.2.1.B.2: publisher 回填（仅当 DB 当前 NULL 才覆盖，避免覆盖手维值）
  if (!journal.publisher) {
    try {
      const pub = extractPublisherFromOpenAlex(openalex);
      if (pub) {
        updates.publisher = pub;
        successFields.push("publisher");
        realProvenance.publisher = "openalex";
      }
    } catch (err) {
      errors["publisher"] = err instanceof Error ? err.message : String(err);
      logger.warn({ journalId, err: errors["publisher"] }, "publisher extractor failed");
    }
  }

  // PR #201 (5-22): 官网 website 回填（仅当 DB 当前 NULL 才填，不覆盖手维/LetPub 真值）
  //   来源 OpenAlex homepage_url（事实型 URL，非近似指标）。新 5000 池 website 多为 NULL，
  //   导致文章里"官网"行被模板藏掉。此回填让文章出现官网链接，免代理。
  if (!journal.website) {
    try {
      const site = extractWebsiteFromOpenAlex(openalex);
      if (site) {
        updates.website = site;
        successFields.push("website");
        realProvenance.website = "openalex";
      }
    } catch (err) {
      errors["website"] = err instanceof Error ? err.message : String(err);
      logger.warn({ journalId, err: errors["website"] }, "website extractor failed");
    }
  }

  // 6-21 官网收稿范围: Jina Reader 抓官网(绕数据中心IP被CF屏蔽) → 复用 LLM extractor 抽 scope。
  //   仅 reverify/refresh cron 显式开启(includeWebsiteScope), 避开每日生成热路径; 已有 scopeDetails 则不重抓。
  const siteUrl = (updates.website as string | undefined) || journal.website;
  if (options?.includeWebsiteScope && siteUrl && !journal.scopeDetails) {
    try {
      const { fetchCleanPage } = await import("./fetchers/shared/jina-web-fetcher.js");
      const md = await fetchCleanPage(siteUrl);
      if (md) {
        const { extractScopeDetails } = await import("./extractors/scope-details-extractor.js");
        const shape = await extractScopeDetails({
          websiteHtml: md,
          journalName: journal.name,
          tenantId: journal.tenantId ?? SYSTEM_RECOMMENDATION_TENANT_ID,
        });
        if (shape) {
          updates.scopeDetails = shape as unknown as JournalUpdate["scopeDetails"];
          const desc = Array.isArray(shape.categories) && shape.categories.length
            ? shape.categories.map((c) => c.title).filter(Boolean).join("、")
            : (shape.submissionNote || null);
          if (desc) updates.scopeDescription = desc;
          successFields.push("scope_details_site");
          realProvenance.scopeDetails = "journal_site";
          logger.info({ journalId, journal: journal.name }, "6-21 官网收稿范围已抓取入库(Jina)");
        }
      }
    } catch (err) {
      failedFields.push("scope_details_site");
      errors["scope_details_site"] = err instanceof Error ? err.message : String(err);
      logger.warn({ journalId, err: errors["scope_details_site"] }, "官网scope抽取失败(不阻塞)");
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
      pkuCoreLevel: (journal as any).pkuCoreLevel ?? null,
      cscdLevel: (journal as any).cscdLevel ?? null,
      catalogs: Array.isArray((journal as any).catalogs) ? (journal as any).catalogs : null,
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

  // PR #107：trust 计算（confidence + dataSource + fieldProvenance）
  const trust = computeTrust({
    crossref: !!crossref,
    doaj: !!doaj,
    scimago: false, // PR #166: scimago 已砍, trust-score 接 4 源 flag (scimago 永远 false)
    letpub: !!letpub,
    // task#104 阶段1: 从本刊已 ingest 的核心目录字段派生信号, 让重富化保住核心信号(否则 confidence 会被重置回 50 冲掉核心分)。
    pkuCore: journal.pkuCoreLevel === "北大核心",
    cscdCore: journal.cscdLevel === "核心库",
    cscdExtended: journal.cscdLevel === "扩展库",
  });
  // sourceUrl 优先级：letpub detail 页 > crossref API  (PR #166: scimago search 已砍)
  const trustSourceUrl =
    letpub && (letpub as { sourceUrl?: string }).sourceUrl
      ? (letpub as { sourceUrl?: string }).sourceUrl
      : crossref && journal.issn
        ? `https://api.crossref.org/journals/${journal.issn}`
        : null;

  if (!options?.dryRun) {
    // 合并 metadata.enrichmentLog（最近 3 条），不破坏其他 metadata 键
    const existingMeta = (journal.metadata as Record<string, unknown>) || {};
    const existingLog: EnrichLogEntry[] = Array.isArray(existingMeta.enrichmentLog)
      ? (existingMeta.enrichmentLog as EnrichLogEntry[])
      : [];
    const newLog = [logEntry, ...existingLog].slice(0, MAX_LOG_ENTRIES);
    // B.4-2: metadata.wanfang sub-key 合并（保留 admin 预填的 perioId 等键）
    const existingWanfang = (existingMeta.wanfang as Record<string, unknown>) || {};
    const newMeta = {
      ...existingMeta,
      enrichmentLog: newLog,
      ...(wanfangData ? { wanfang: { ...existingWanfang, ...wanfangData } } : {}),
    };

    // PR #107：trust 5 列写入（仅当至少 1 源命中才覆盖 dataSource，避免破坏 manual_seed_2024）
    // PR #165a: merge realProvenance (真实字段来源 from extractors) 入 trust.fieldProvenance (默认 mapping)
    // realProvenance 覆盖 trust 默认 (后者准确性低), 后者作 fallback
    const mergedProvenance = { ...trust.fieldProvenance, ...realProvenance };
    const trustUpdate: Partial<typeof journals.$inferInsert> = {
      confidence: trust.confidence,
      lastVerifiedAt: new Date(),
      ...(trust.dataSource ? { dataSource: trust.dataSource } : {}),
      ...(trustSourceUrl ? { sourceUrl: trustSourceUrl } : {}),
      ...(Object.keys(mergedProvenance).length > 0 ? { fieldProvenance: mergedProvenance } : {}),
    };

    await db.update(journals)
      .set({ ...updates, ...trustUpdate, metadata: newMeta, updatedAt: new Date() })
      .where(eq(journals.id, journalId));

    // PR #165b: 每源写一行 journal_enrichment_log (failed/success/timeout 都记) 给 PR #165c/d 决策基线
    // perSourceFieldsWritten: 从 realProvenance 反向 group by source
    const perSourceFieldsWritten: Record<string, string[]> = {};
    for (const [field, source] of Object.entries(realProvenance)) {
      for (const s of source.split("+")) {
        (perSourceFieldsWritten[s] ||= []).push(field);
      }
    }
    const logRows = [
      { source: "letpub", timed: letpubTimed, hasData: !!letpub },
      { source: "doaj", timed: doajTimed, hasData: !!doaj },
      { source: "openalex", timed: openalexTimed, hasData: !!openalex },
      { source: "fenqubiao", timed: fenqubiaoTimed, hasData: !!warningList },
      { source: "wanfang", timed: wanfangTimed, hasData: !!wanfangRaw },
      { source: "crossref", timed: crossrefTimed, hasData: !!crossref },
    ].map((r) => ({
      journalId,
      source: r.source,
      // 即使 success 但 hasData=false (e.g. ISSN 不存在 doaj/scimago 找不到) 算 'skipped' 区别于 'failed' (fetcher 抛错)
      status: r.timed.status === "success" ? (r.hasData ? "success" : "skipped") : r.timed.status,
      fieldsWritten: perSourceFieldsWritten[r.source] ?? [],
      errorMessage: r.timed.error?.slice(0, 500) ?? null,
      durationMs: r.timed.ms,
    }));
    try {
      await db.insert(journalEnrichmentLog).values(logRows);
    } catch (err) {
      // 观察日志失败不阻塞主流程
      logger.warn({ journalId, err: err instanceof Error ? err.message : String(err) }, "PR #165 enrichment log insert failed");
    }

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
    letpubOutcome,
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
