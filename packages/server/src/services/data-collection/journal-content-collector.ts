/**
 * 期刊内容采集器
 *
 * 根据用户主题，自动：
 * 1. 从 keywords 表找到相关热词
 * 2. 在 journals 表匹配期刊（按 IF 排序）
 * 3. 用 PubMed API 抓取最新研究摘要
 * 4. 获取期刊封面图和数据卡片
 * 5. 将内容存入知识库 domain_knowledge 子库
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { keywords, journals } from "../../models/schema.js";
import { eq, and, desc, or, ilike, sql, isNull, isNotNull, ne, gt } from "drizzle-orm";
import { createEntry } from "../knowledge/knowledge-service.js";
import {
  fetchJournalCoverMultiSource,
  generateJournalDataCard,
  svgToDataUri,
} from "../crawler/journal-image-crawler.js";
import { persistJournalCover } from "../crawler/journal-cover-persist.js";
import { scrapeLetPubDetail } from "../crawler/letpub-detail-scraper.js";
import { scrapeCnkiJournal, scrapeWanfangJournal } from "../crawler/cnki-journal-scraper.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型 ============

export interface JournalInfo {
  name: string;
  nameEn: string | null;
  issn: string | null;
  publisher: string | null;
  discipline: string | null;
  partition: string | null;
  impactFactor: number | null;
  acceptanceRate: number | null;
  acceptanceDifficulty: string | null; // PR #235: ablesci 模糊词 (容易/较易/中等/较难/困难)
  reviewCycle: string | null;
  annualVolume: number | null;
  isWarningList: boolean;
  warningYear: string | null;
  coverUrl: string | null;
  dataCardUri: string;
  // V6 新增：顺仕美途模板所需字段
  abbreviation: string | null;
  foundingYear: number | null;
  country: string | null;
  website: string | null;
  apcFee: number | null;
  selfCitationRate: number | null;
  casPartition: string | null;
  casPartitionNew: string | null;
  jcrSubjects: string | null; // JSON string
  topInstitutions: string | null; // JSON string
  scopeDescription: string | null;
  // PR #203: 同档期刊对比 (池内同分区/同学科, IF 相近的 2-3 本, 全用可信字段)
  peerJournals?: Array<{ name: string; nameEn: string | null; impactFactor: number | null; acceptanceRate: number | null; apcFee: number | null; casPartition: string | null }>;
  // V7 新增：LetPub 详情数据（用于生成图表插图）
  ifHistory?: Array<{ year: number; value: number }>;           // 影响因子历年
  pubVolumeHistory?: Array<{ year: number; count: number }>;    // 发文量历年
  letpubCasPartitions?: Array<{
    version: string;
    publishDate?: string;
    majorCategory: string;
    subCategories: Array<{ zone: string; subject: string }>;
    isTop: boolean;
    isReview: boolean;
  }>;
  letpubJcrPartitions?: Array<{
    subject: string;
    database: string;
    zone: string;
    rank: string;
  }>;
  letpubJciPartitions?: Array<{
    subject: string;
    database: string;
    zone: string;
    rank: string;
  }>;
  // V10 新增：国内期刊专有字段
  cnNumber?: string | null;                  // 国内统一刊号 CN xx-xxxx/X
  catalogType?: string | null;               // "sci" | "pku-core" | "cssci" | "cscd" 等
  catalogs?: string[];                       // 所属核心目录列表 ["cssci","pku-core","cscd"]
  coreLevel?: string | null;                 // "核心" | "扩展" | "来源"
  cscdLevel?: string | null;                 // "核心库" | "扩展库"（B.4-1 静态目录，journal_kind 判定要用）
  pkuCoreLevel?: string | null;              // "北大核心"（同上）
  frequency?: string | null;                 // "月刊" | "双月刊" | "季刊"
  compositeIF?: number | null;               // 复合影响因子（知网）
  comprehensiveIF?: number | null;           // 综合影响因子（知网）
  cnkiUrl?: string | null;                   // 知网期刊主页 URL
  coreSubjects?: string[];                   // 核心版学科分类（如 ["计算机科学","自动化"]）
  organizerName?: string | null;             // 主办单位
  supervisorName?: string | null;            // 主管单位
  synthetic?: boolean;                       // 是否为 AI 推荐的合成期刊（非数据库真实数据）
  // V12 新增：高清封面 & Springer CDN 字段（供 cover-fetcher 使用）
  id?: string;                               // DB journal.id（用于缓存写回）
  coverUrlHd?: string | null;                // 高清封面 URL（Springer CDN 缓存）
  springerJournalId?: string | null;         // Springer Link journal ID
  // V13（task #11）：8 enricher jsonb 字段，喂给 article-skill prompt 做深度分析。
  // 注意：这是 V7 prompt 形态（统一过的），不是 V12 enricher 原 shape。
  // collector 用 toPromptFormat 单向适配（V12 → V7），其他用 V7 形态的代码（template
  // 渲染等）保持不变 —— schema 双形态分裂留 task #realignment 后续统一。
  promptIfHistory?: Array<{ year: number; value: number }>;     // 统一后 IF 历史
  promptIfPredicted?: { year: number; value: number; source?: string } | null;
  promptJcrFull?: {
    wosLevel?: string;
    jifSubjects?: Array<{ subject: string; zone?: string; rank?: string; database?: string }>;
    jciSubjects?: Array<{ subject: string; zone?: string; rank?: string; database?: string }>;
    isTopJournal?: boolean;
    isReviewJournal?: boolean;
  };
  promptPublicationStats?: {
    frequency?: string;
    annualVolumeHistory?: Array<{ year: number; count: number }>;
    topInstitutions?: Array<{ name: string; paperCount?: number; percentile?: number; country?: string }>;
  };
  promptScopeDetails?: {
    categories?: Array<{ title: string; description?: string }>;
    articleTypes?: string[];
    submissionNote?: string;
    subjectDistribution?: Array<{ subject: string; percent: number }>;
  };
  promptPublicationCosts?: {
    apc?: number;
    currency?: string;
    openAccess?: boolean;
    fastTrack?: boolean;
  };
  promptCitingTop10?: {
    topJournals?: Array<{ name: string; count: number; percent?: number }>;
    selfCitationRate?: number;
    selfCitationConfidence?: "low" | "medium" | "high";
    totalCitations?: number;
  };
  promptCarIndex?: {
    data?: Array<{ year: number; carIndex: number }>;
    riskLevel?: "low" | "mid" | "high";
    isWarningListed?: boolean;
  };
  // PR B.10：8 V12 jsonb raw 透传给模板渲染层（shunshi-style 4 SVG chart 槽位）。
  // V12 enricher 写 jsonb 用 `{data:[{year,if}]}` 等 shape；prompt* 是单向 V7 适配（喂 LLM）；
  // 这 8 个 raw 字段是 DB jsonb 原样透传，给 template type guard 直接消费。
  // ifHistory 已被 LetPub V7 占用 → 用 ifHistoryRaw 区分；其他 7 字段无冲突沿用 DB 列名。
  ifHistoryRaw?: unknown;
  carIndexHistory?: unknown;
  publicationStats?: unknown;
  citingJournalsTop10?: unknown;
  publicationCosts?: unknown;
  jcrFull?: unknown;
  scopeDetails?: unknown;
  recommendationScore?: unknown;
}

/**
 * V12 enricher → V7 prompt 形态单向适配。
 *
 * V12 jsonb shape：`{ data: [{year, if}], predicted, lastUpdatedAt }`（admin v2 / enricher 写）
 * V7 prompt shape：`[{year, value}]`（journal-template / article-skill 消费）
 *
 * 历史遗留 schema 不一致 — 严格只在这一处适配，不改 schema / 不改 enricher / 不改 admin 表单。
 */
export function toPromptIfHistory(
  raw: unknown,
): { history: Array<{ year: number; value: number }>; predicted: { year: number; value: number; source?: string } | null } {
  if (!raw) return { history: [], predicted: null };
  // V12 enricher：含 data + predicted
  if (typeof raw === "object" && raw !== null && "data" in raw) {
    const v12 = raw as { data?: Array<{ year: number; if: number }>; predicted?: { year: number; if: number; source?: string } };
    return {
      history: Array.isArray(v12.data) ? v12.data.map((d) => ({ year: d.year, value: d.if })) : [],
      predicted: v12.predicted ? { year: v12.predicted.year, value: v12.predicted.if, source: v12.predicted.source } : null,
    };
  }
  // V7 LetPub：直接 array
  if (Array.isArray(raw)) {
    return { history: raw as Array<{ year: number; value: number }>, predicted: null };
  }
  return { history: [], predicted: null };
}

export interface CollectionResult {
  hotKeywords: string[];
  journals: JournalInfo[];
  abstracts: Array<{
    title: string;
    journal: string;
    pmid: string;
    abstractText: string;
  }>;
  knowledgeEntriesCreated: number;
}

interface PubMedAbstract {
  pmid: string;
  title: string;
  abstractText: string;
  journal: string;
  date: string;
  impactFactor?: number | null;
  partition?: string | null;
}

// ============ 核心 ============

export async function collectJournalContent(params: {
  tenantId: string;
  topic: string;
  keywords?: string[];
  /** PR B.13：原始用户输入。LLM understandRequirement 把"The Lancet" 精确刊名
   * normalize 成"医学顶刊"等模糊词后 ILIKE 命中不到，所以原 prompt 也喂进
   * journalConds（同 PR B.11 五层 fallback：ISSN / 完整 / 去括号 / token / 学科）。 */
  rawUserPrompt?: string;
}): Promise<CollectionResult> {
  const { tenantId, topic } = params;
  logger.info({ tenantId, topic, rawUserPrompt: params.rawUserPrompt }, "期刊内容采集开始");

  // A: 从 keywords 表查找相关热词
  const hotKeywordRows = await db
    .select()
    .from(keywords)
    .where(
      and(
        eq(keywords.tenantId, tenantId),
        ilike(keywords.keyword, `%${topic}%`)
      )
    )
    .orderBy(desc(keywords.compositeScore))
    .limit(10);

  const hotKeywords = hotKeywordRows.map((k) => k.keyword);
  // 合并用户传入的关键词
  const allKeywords = [...new Set([topic, ...hotKeywords, ...(params.keywords || [])])];

  // B: 匹配 journals 表中的期刊（优先有封面图的）
  // PR B.11：多 token + ISSN 路由（chat parser 把"The Lancet" 包成"The Lancet（柳叶刀）"，
  // 整串 ILIKE 永远命不中 DB 里 name="柳叶刀" / nameEn="The Lancet" → 全部走 AI 合成。
  // 命中优先级：ISSN 完全匹配 > 完整 topic > 去括号 topic > 每个 token 子串 > hotKeywords 学科）。
  const issnMatch = topic.match(/\b\d{4}-\d{3}[\dxX]\b/);
  const cleanedTopic = topic.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
  const tokens = cleanedTopic.split(/\s+/).filter((t) => t.length >= 2);
  const journalConds: any[] = [];
  if (issnMatch) journalConds.push(ilike(journals.issn, issnMatch[0]));
  journalConds.push(ilike(journals.discipline, `%${topic}%`));
  journalConds.push(ilike(journals.name, `%${topic}%`));
  journalConds.push(ilike(journals.nameEn, `%${topic}%`));
  if (cleanedTopic && cleanedTopic !== topic) {
    journalConds.push(ilike(journals.name, `%${cleanedTopic}%`));
    journalConds.push(ilike(journals.nameEn, `%${cleanedTopic}%`));
  }
  for (const tok of tokens) {
    if (tok === cleanedTopic) continue; // 整串已加，单 token 等于整串时跳过
    journalConds.push(ilike(journals.name, `%${tok}%`));
    journalConds.push(ilike(journals.nameEn, `%${tok}%`));
  }
  if (hotKeywords.length > 0) journalConds.push(ilike(journals.discipline, `%${hotKeywords[0]}%`));
  // PR B.13：原始用户输入也作为候选（与 topic 相同时跳过避免重复）。同 PR B.11 的 5 层 fallback。
  const rawPrompt = params.rawUserPrompt;
  if (rawPrompt && rawPrompt !== topic) {
    const rawIssn = rawPrompt.match(/\b\d{4}-\d{3}[\dxX]\b/);
    if (rawIssn && !issnMatch) journalConds.push(ilike(journals.issn, rawIssn[0]));
    journalConds.push(ilike(journals.name, `%${rawPrompt}%`));
    journalConds.push(ilike(journals.nameEn, `%${rawPrompt}%`));
    const rawCleaned = rawPrompt.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
    if (rawCleaned && rawCleaned !== rawPrompt) {
      journalConds.push(ilike(journals.name, `%${rawCleaned}%`));
      journalConds.push(ilike(journals.nameEn, `%${rawCleaned}%`));
    }
    const rawTokens = rawCleaned.split(/\s+/).filter((t) => t.length >= 2);
    for (const tok of rawTokens) {
      if (tok === rawCleaned) continue;
      journalConds.push(ilike(journals.name, `%${tok}%`));
      journalConds.push(ilike(journals.nameEn, `%${tok}%`));
    }
  }
  // PR B.12：journals 改全局共享 reference data。
  // tenant_id NULL = 全局期刊（46 enriched，所有 tenant 共享）；非 NULL = 该 tenant 自定义。
  // 这个 OR 让当前 tenant 既能看自己的 custom，又能用全局 enriched 元数据。
  const matchedJournals = await db
    .select()
    .from(journals)
    .where(and(or(isNull(journals.tenantId), eq(journals.tenantId, tenantId)), or(...journalConds)))
    .orderBy(
      // PR B.14：动态拼 orderBy（无 issnMatch 时跳过该子句）。
      // 旧 `sql\`0\`` PG 视为 position 0（select list 从 1 起）→ "ORDER BY position 0 is not in select list"。
      ...(issnMatch ? [sql`CASE WHEN ${journals.issn} = ${issnMatch[0]} THEN 0 ELSE 1 END`] : []),
      sql`CASE WHEN ${journals.coverImageUrl} IS NOT NULL THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${journals.impactFactor} IS NOT NULL THEN 0 ELSE 1 END`,
      desc(journals.impactFactor)
    )
    .limit(5);

  // C: PubMed 抓取摘要
  const pubmedAbstracts: PubMedAbstract[] = [];
  const searchTerms = allKeywords.slice(0, 3).join(" OR ");

  try {
    const abstracts = await fetchPubMedAbstracts(searchTerms, 5);
    pubmedAbstracts.push(
      ...abstracts.map((a) => ({
        ...a,
        impactFactor: null as number | null,
        partition: null as string | null,
      }))
    );
  } catch (err) {
    logger.warn({ err, topic }, "PubMed 采集失败");
  }

  // 如果有匹配的期刊，用期刊名额外搜索
  for (const journal of matchedJournals.slice(0, 2)) {
    try {
      const jAbstracts = await fetchPubMedAbstracts(
        `${topic} AND "${journal.name}"`,
        2
      );
      pubmedAbstracts.push(
        ...jAbstracts.map((a) => ({
          ...a,
          journal: journal.name,
          impactFactor: journal.impactFactor,
          partition: journal.partition,
        }))
      );
    } catch (err) {
      logger.debug({ err, journal: journal.name }, "期刊专项搜索失败");
    }
  }

  // D: 期刊封面和数据卡片（优先使用 DB 缓存，无缓存时尝试实时抓取）
  const journalResults: CollectionResult["journals"] = [];
  for (const journal of matchedJournals) {
    // 优先用 DB 中缓存的封面 URL
    let coverUrl: string | null = (journal as any).coverImageUrl || null;

    // 无缓存时尝试实时抓取（并回写 DB）
    if (!coverUrl) {
      try {
        // 优先用英文名搜索 LetPub（LetPub 以英文名为主），中文名做兜底
        const searchName = journal.nameEn || journal.name;
        logger.info({ searchName, issn: journal.issn, journalId: journal.id }, "开始抓取期刊封面图");
        coverUrl = await fetchJournalCoverMultiSource(searchName, journal.issn || undefined);

        // 英文名没找到，用中文名再试一次
        if (!coverUrl && journal.nameEn && journal.name !== journal.nameEn) {
          coverUrl = await fetchJournalCoverMultiSource(journal.name, journal.issn || undefined);
        }

        // 回写缓存（T6-C: 走 idempotent helper，统一 source 命名）
        if (coverUrl) {
          logger.info({ coverUrl, journal: journal.name }, "期刊封面图抓取成功，回写 DB 缓存");
          await persistJournalCover(journal.id, coverUrl, "inline-collector");
        } else {
          logger.warn({ journal: journal.name, searchName }, "期刊封面图未找到");
        }
      } catch (err) {
        logger.warn({ err, journal: journal.name }, "期刊封面图抓取异常");
      }
    }

    const dataCardSvg = generateJournalDataCard({
      name: journal.name,
      nameEn: journal.nameEn || undefined,
      impactFactor: journal.impactFactor || undefined,
      partition: journal.partition || undefined,
      acceptanceRate: journal.acceptanceRate || undefined,
      reviewCycle: journal.reviewCycle || undefined,
      isWarningList: journal.isWarningList,
    });
    const dataCardUri = svgToDataUri(dataCardSvg);

    // E: 从 LetPub 抓取详情数据（IF 历年、发文量、分区表）用于文章图表
    let ifHistory: Array<{ year: number; value: number }> | undefined;
    let pubVolumeHistory: Array<{ year: number; count: number }> | undefined;
    let letpubCasPartitions: JournalInfo["letpubCasPartitions"];
    let letpubJcrPartitions: JournalInfo["letpubJcrPartitions"];
    let letpubJciPartitions: JournalInfo["letpubJciPartitions"];

    try {
      const letpubDetail = await scrapeLetPubDetail(
        journal.name,
        journal.issn || undefined
      );
      if (letpubDetail) {
        ifHistory = letpubDetail.ifHistory.length > 0 ? letpubDetail.ifHistory : undefined;
        pubVolumeHistory = letpubDetail.pubVolumeHistory.length > 0 ? letpubDetail.pubVolumeHistory : undefined;
        letpubCasPartitions = letpubDetail.casPartitions.length > 0 ? letpubDetail.casPartitions : undefined;
        letpubJcrPartitions = letpubDetail.jcrPartitions.length > 0 ? letpubDetail.jcrPartitions : undefined;
        letpubJciPartitions = letpubDetail.jciPartitions.length > 0 ? letpubDetail.jciPartitions : undefined;

        // 如果 LetPub 返回了封面而之前没有，也用上
        if (!coverUrl && letpubDetail.coverImageUrl) {
          coverUrl = letpubDetail.coverImageUrl;
        }

        logger.info(
          {
            journal: journal.name,
            ifYears: ifHistory?.length || 0,
            pubYears: pubVolumeHistory?.length || 0,
          },
          "LetPub 详情数据已采集"
        );
      }
    } catch (err) {
      logger.debug({ journal: journal.name, err: String(err) }, "LetPub 详情采集失败（不影响主流程）");
    }

    // F: 国内期刊数据采集（知网 + 万方）
    // 触发条件：中国出版 或 DB 中有 catalogType 或 没有国际 IF 数据
    let cnNumber: string | null = (journal as any).cnNumber || null;
    let catalogs: string[] = ((journal as any).catalogs as string[]) || [];
    let compositeIF: number | null = (journal as any).compositeImpactFactor ?? null; // 6-20: 先用已持久化值, 无则待爬
    let comprehensiveIF: number | null = null;
    let cnkiUrl: string | null = null;
    let coreSubjects: string[] = [];
    let organizerName: string | null = (journal as any).publisher || null;
    let supervisorName: string | null = null;
    let frequency: string | null = (journal as any).frequency || null;
    let coreLevel: string | null = (journal as any).coreLevel || null;
    let catalogType: string | null = (journal as any).catalogType || null;

    const isDomestic = (journal as any).country === "中国"
      || (journal as any).catalogType
      || cnNumber
      || (!journal.impactFactor && /[\u4e00-\u9fa5]/.test(journal.name));

    // 7-20 合规红线熔断: 知网抓取默认关闭(env CNKI_SCRAPE_ENABLED 未配 = false)。
    //   关闭后走的是"本就没有知网数据"的状态 —— 库里 provenance/metadata/source_url/data_source
    //   四处 cnki 痕迹均为 0, 说明这条路从未成功产出过数据, 关掉零功能损失。
    //   下方所有 cnkiDetail 派生字段(cnNumber/compositeIF/coreSubjects/organizer…)保持原有的
    //   "无知网数据"分支, 由后续 万方/LetPub/OpenAlex 等合规源填充。
    if (isDomestic && env.CNKI_SCRAPE_ENABLED) {
      try {
        const cnkiDetail = await scrapeCnkiJournal(journal.name, journal.issn || undefined);
        if (cnkiDetail) {
          cnNumber = cnNumber || cnkiDetail.cnNumber;
          compositeIF = cnkiDetail.compositeIF;
          comprehensiveIF = cnkiDetail.comprehensiveIF;
          cnkiUrl = cnkiDetail.cnkiUrl;
          coreSubjects = cnkiDetail.coreSubjects.length > 0 ? cnkiDetail.coreSubjects : coreSubjects;
          organizerName = cnkiDetail.organizer || organizerName;
          supervisorName = cnkiDetail.supervisor;
          frequency = cnkiDetail.frequency || frequency;

          // 合并核心目录（去重）
          if (cnkiDetail.catalogs.length > 0) {
            const allCatalogs = new Set([...catalogs, ...cnkiDetail.catalogs]);
            catalogs = Array.from(allCatalogs);
          }

          // 补充缺失的基本信息
          if (!journal.nameEn && cnkiDetail.nameEn) {
            journal.nameEn = cnkiDetail.nameEn;
          }
          if (!(journal as any).foundingYear && cnkiDetail.foundingYear) {
            (journal as any).foundingYear = cnkiDetail.foundingYear;
          }

          logger.info(
            {
              journal: journal.name,
              compositeIF,
              catalogs,
              cnNumber,
            },
            "知网期刊数据已采集"
          );
        }
      } catch (err) {
        logger.debug({ journal: journal.name, err: String(err) }, "知网采集失败（不影响主流程）");
      }

      // 万方作为补充（知网没拿到关键数据时尝试）
      if (!compositeIF && !cnNumber) {
        try {
          const wfDetail = await scrapeWanfangJournal(journal.name, journal.issn || undefined);
          if (wfDetail) {
            cnNumber = cnNumber || wfDetail.cnNumber;
            compositeIF = compositeIF || wfDetail.compositeIF;
            organizerName = organizerName || wfDetail.organizer;
            if (wfDetail.catalogs.length > 0) {
              const allCatalogs = new Set([...catalogs, ...wfDetail.catalogs]);
              catalogs = Array.from(allCatalogs);
            }
            logger.info({ journal: journal.name }, "万方期刊补充数据已采集");
          }
        } catch (err) {
          logger.debug({ journal: journal.name, err: String(err) }, "万方采集失败（不影响主流程）");
        }
      }

      // 推断 catalogType（如果 DB 没有）
      if (!catalogType && catalogs.length > 0) {
        if (catalogs.includes("cssci")) catalogType = "cssci";
        else if (catalogs.includes("cscd")) catalogType = "cscd";
        else if (catalogs.includes("pku-core")) catalogType = "pku-core";
        else if (catalogs.includes("cstpcd")) catalogType = "cstpcd";
      }

      // 推断 coreLevel
      if (!coreLevel && catalogs.length > 0) {
        if (catalogs.includes("pku-core") || catalogs.includes("cssci") || catalogs.includes("cscd")) {
          coreLevel = "核心";
        } else if (catalogs.includes("cstpcd")) {
          coreLevel = "来源";
        }
      }
    }

    // 6-20: 复合影响因子回填 journals(知网/万方新爬到且与库里不同时), 持久化避免每次重爬+模板可读。
    if (compositeIF && journal.id && compositeIF !== ((journal as any).compositeImpactFactor ?? null)) {
      try {
        await db.update(journals).set({ compositeImpactFactor: compositeIF }).where(eq(journals.id, journal.id));
        logger.info({ journal: journal.name, compositeIF }, "6-20 复合影响因子已回填 journals");
      } catch (err) { logger.debug({ journal: journal.name, err: String(err) }, "复合IF回填失败(不阻塞)"); }
    }

    // PR #203: 同档期刊对比 — 拉池内同分区(无分区时同学科)、IF 相近的 2-3 本 (全用可信字段)
    let peerJournals: JournalInfo["peerJournals"] = [];
    try {
      const peerConds: any[] = [];
      if ((journal as any).casPartition) peerConds.push(eq(journals.casPartition, (journal as any).casPartition));
      else if (journal.discipline) peerConds.push(eq(journals.discipline, journal.discipline));
      if (peerConds.length > 0) {
        const ifv = journal.impactFactor;
        const peers = await db
          .select({ name: journals.name, nameEn: journals.nameEn, impactFactor: journals.impactFactor, acceptanceRate: journals.acceptanceRate, apcFee: journals.apcFee, casPartition: journals.casPartition })
          .from(journals)
          .where(and(
            or(isNull(journals.tenantId), eq(journals.tenantId, tenantId)),
            ne(journals.id, journal.id),
            isNotNull(journals.impactFactor),
            gt(journals.impactFactor, 0), // PR #209: 排除 IF=0 占位值的期刊
            ...peerConds,
          ))
          .orderBy(
            ...(typeof ifv === "number" ? [sql`ABS(${journals.impactFactor} - ${ifv})`] : [desc(journals.impactFactor)]),
          )
          .limit(3);
        peerJournals = peers;
      }
    } catch (err) {
      logger.warn({ err: String(err), journalId: journal.id }, "同档期刊对比查询失败");
    }

    journalResults.push({
      name: journal.name,
      nameEn: journal.nameEn,
      peerJournals,
      issn: journal.issn,
      publisher: journal.publisher,
      discipline: journal.discipline,
      partition: journal.partition,
      impactFactor: journal.impactFactor,
      acceptanceRate: journal.acceptanceRate,
      reviewCycle: journal.reviewCycle,
      annualVolume: journal.annualVolume,
      isWarningList: journal.isWarningList,
      warningYear: journal.warningYear,
      abbreviation: (journal as any).abbreviation || null,
      foundingYear: (journal as any).foundingYear || null,
      country: (journal as any).country || null,
      website: (journal as any).website || null,
      apcFee: (journal as any).apcFee || null,
      selfCitationRate: (journal as any).selfCitationRate || null,
      acceptanceDifficulty: (journal as any).acceptanceDifficulty || null, // PR #235
      casPartition: (journal as any).casPartition || null,
      casPartitionNew: (journal as any).casPartitionNew || null,
      jcrSubjects: (journal as any).jcrSubjects || null,
      topInstitutions: (journal as any).topInstitutions || null,
      scopeDescription: (journal as any).scopeDescription || null,
      coverUrl,
      dataCardUri,
      // V12: 高清封面 & Springer CDN（供 cover-fetcher 使用）
      id: journal.id,
      coverUrlHd: (journal as any).coverUrlHd || null,
      springerJournalId: (journal as any).springerJournalId || null,
      // V7: LetPub 图表数据
      ifHistory,
      pubVolumeHistory,
      letpubCasPartitions,
      letpubJcrPartitions,
      letpubJciPartitions,
      // V10: 国内期刊字段
      cnNumber,
      catalogType,
      catalogs: catalogs.length > 0 ? catalogs : undefined,
      coreLevel,
      // 7-28: CSCD/北大核心等级透传 —— 它们是"定义裂缝刊"的唯一国内信号(enricher 只写这两列、
      //   不回写 catalogs), 不透传就会让 article-skill 的 journal_kind 判定看不见, 按国外刊写。
      cscdLevel: (journal as any).cscdLevel ?? null,
      pkuCoreLevel: (journal as any).pkuCoreLevel ?? null,
      frequency,
      compositeIF,
      comprehensiveIF,
      cnkiUrl,
      coreSubjects: coreSubjects.length > 0 ? coreSubjects : undefined,
      organizerName,
      supervisorName,
      // V13: 8 enricher jsonb → prompt 形态映射（V12 enricher → V7 单向，sparse 字段保留 undefined）
      ...(() => {
        const j = journal as Record<string, unknown>;
        const ifConverted = toPromptIfHistory(j.ifHistory);
        // PR B.10：ifHistoryRaw 优先 DB V12，DB null 时把 LetPub V7 array 包成 V12 shape，
        // 让 shunshi-style template 的 isIfHistory({data:Array}) guard 能命中。
        const ifHistoryRaw = j.ifHistory != null
          ? j.ifHistory
          : (ifHistory && ifHistory.length > 0
              ? { data: ifHistory.map((d) => ({ year: d.year, if: d.value })) }
              : undefined);
        return {
          promptIfHistory: ifConverted.history.length > 0 ? ifConverted.history : undefined,
          promptIfPredicted: ifConverted.predicted,
          promptJcrFull: (j.jcrFull as JournalInfo["promptJcrFull"]) || undefined,
          promptPublicationStats: (j.publicationStats as JournalInfo["promptPublicationStats"]) || undefined,
          promptScopeDetails: (j.scopeDetails as JournalInfo["promptScopeDetails"]) || undefined,
          promptPublicationCosts: (j.publicationCosts as JournalInfo["promptPublicationCosts"]) || undefined,
          promptCitingTop10: (j.citingJournalsTop10 as JournalInfo["promptCitingTop10"]) || undefined,
          promptCarIndex: (j.carIndexHistory as JournalInfo["promptCarIndex"]) || undefined,
          // PR B.10：8 V12 raw 透传给 template（4 SVG chart 槽位 + JCR 全表 + 收稿范围 + 出版费 + 推荐分）
          ifHistoryRaw,
          carIndexHistory: j.carIndexHistory ?? undefined,
          publicationStats: j.publicationStats ?? undefined,
          citingJournalsTop10: j.citingJournalsTop10 ?? undefined,
          publicationCosts: j.publicationCosts ?? undefined,
          jcrFull: j.jcrFull ?? undefined,
          scopeDetails: j.scopeDetails ?? undefined,
          recommendationScore: j.recommendationScore ?? undefined,
        };
      })(),
    });
  }

  // E: 写入知识库
  let knowledgeEntriesCreated = 0;

  // PubMed 摘要 → domain_knowledge
  for (const abstract of pubmedAbstracts) {
    try {
      const ifInfo = abstract.impactFactor ? `IF: ${abstract.impactFactor}` : "";
      const partInfo = abstract.partition ? `${abstract.partition}区` : "";
      const journalMeta = [ifInfo, partInfo].filter(Boolean).join(", ");

      await createEntry({
        tenantId,
        category: "domain_knowledge" as VectorCategory,
        title: `[${abstract.journal}] ${abstract.title}`,
        content: [
          `期刊：${abstract.journal}${journalMeta ? `（${journalMeta}）` : ""}`,
          `发表日期：${abstract.date}`,
          `摘要：${abstract.abstractText}`,
          `PMID: ${abstract.pmid}`,
        ].join("\n"),
        source: `PubMed - ${abstract.pmid}`,
        metadata: { pmid: abstract.pmid, journal: abstract.journal },
      });
      knowledgeEntriesCreated++;
    } catch (err) {
      logger.debug({ err, pmid: abstract.pmid }, "摘要入库失败（可能重复）");
    }
  }

  // 期刊元数据 → domain_knowledge
  for (const journal of matchedJournals) {
    try {
      await createEntry({
        tenantId,
        category: "domain_knowledge" as VectorCategory,
        title: `期刊简介：${journal.name}`,
        content: [
          `${journal.name}${journal.issn ? `（ISSN: ${journal.issn}）` : ""}`,
          `学科：${journal.discipline || "未分类"}`,
          journal.impactFactor ? `影响因子：${journal.impactFactor}` : "",
          journal.partition ? `分区：${journal.partition}` : "",
          journal.reviewCycle ? `审稿周期：${journal.reviewCycle}` : "",
          journal.isWarningList ? "⚠️ 预警期刊" : "",
        ]
          .filter(Boolean)
          .join("\n"),
        source: "LetPub/OpenAlex",
        metadata: { issn: journal.issn, discipline: journal.discipline },
      });
      knowledgeEntriesCreated++;
    } catch (err) {
      logger.debug({ err, journal: journal.name }, "期刊入库失败（可能重复）");
    }
  }

  const result: CollectionResult = {
    hotKeywords,
    journals: journalResults,
    abstracts: pubmedAbstracts.map((a) => ({
      title: a.title,
      journal: a.journal,
      pmid: a.pmid,
      abstractText: a.abstractText,
    })),
    knowledgeEntriesCreated,
  };

  logger.info(
    {
      topic,
      hotKeywords: hotKeywords.length,
      journals: journalResults.length,
      abstracts: pubmedAbstracts.length,
      knowledgeEntries: knowledgeEntriesCreated,
    },
    "期刊内容采集完成"
  );

  return result;
}

// ============ PubMed API ============

async function fetchPubMedAbstracts(
  query: string,
  maxResults: number
): Promise<Array<{ pmid: string; title: string; abstractText: string; journal: string; date: string }>> {
  // Step 1: esearch — 获取 PMID 列表
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&sort=date&retmode=json`;

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`PubMed search failed: ${searchRes.status}`);

  const searchData = (await searchRes.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  const pmids = searchData.esearchresult?.idlist || [];

  if (pmids.length === 0) return [];

  // Step 2: efetch — 获取摘要详情
  const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(",")}&rettype=xml&retmode=xml`;

  const fetchRes = await fetch(fetchUrl);
  if (!fetchRes.ok) throw new Error(`PubMed fetch failed: ${fetchRes.status}`);

  const xmlText = await fetchRes.text();

  // 简单 XML 解析（不引入 XML 库）
  const results: Array<{
    pmid: string;
    title: string;
    abstractText: string;
    journal: string;
    date: string;
  }> = [];

  const articles = xmlText.split("<PubmedArticle>");
  for (const article of articles.slice(1)) {
    const pmid = extractXmlTag(article, "PMID") || "";
    const title = extractXmlTag(article, "ArticleTitle") || "";
    const abstractText = extractXmlTag(article, "AbstractText") || "";
    const journal = extractXmlTag(article, "Title") || extractXmlTag(article, "ISOAbbreviation") || "";
    const year = extractXmlTag(article, "Year") || "";
    const month = extractXmlTag(article, "Month") || "";

    if (pmid && (title || abstractText)) {
      results.push({
        pmid,
        title: cleanXmlText(title),
        abstractText: cleanXmlText(abstractText).slice(0, 1500),
        journal: cleanXmlText(journal),
        date: `${year}-${month || "01"}`,
      });
    }
  }

  return results;
}

function extractXmlTag(xml: string, tag: string): string | null {
  // 匹配第一个出现的标签（忽略属性）
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1] : null;
}

function cleanXmlText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "") // 移除嵌套标签
    .replace(/\s+/g, " ")    // 合并空白
    .trim();
}
