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

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { keywords, journals } from "../../models/schema.js";
import { eq, and, desc, or, ilike } from "drizzle-orm";
import { createEntry } from "../knowledge/knowledge-service.js";
import {
  fetchJournalCoverMultiSource,
  generateJournalDataCard,
  svgToDataUri,
} from "../crawler/journal-image-crawler.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型 ============

export interface CollectionResult {
  hotKeywords: string[];
  journals: Array<{
    name: string;
    impactFactor: number | null;
    partition: string | null;
    coverUrl: string | null;
    dataCardUri: string;
  }>;
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
}): Promise<CollectionResult> {
  const { tenantId, topic } = params;
  logger.info({ tenantId, topic }, "期刊内容采集开始");

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

  // B: 匹配 journals 表中的期刊
  const matchedJournals = await db
    .select()
    .from(journals)
    .where(
      and(
        eq(journals.tenantId, tenantId),
        or(
          ilike(journals.discipline, `%${topic}%`),
          ilike(journals.name, `%${topic}%`),
          ...(hotKeywords.length > 0
            ? [ilike(journals.discipline, `%${hotKeywords[0]}%`)]
            : [])
        )
      )
    )
    .orderBy(desc(journals.impactFactor))
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

  // D: 期刊封面和数据卡片
  const journalResults: CollectionResult["journals"] = [];
  for (const journal of matchedJournals) {
    let coverUrl: string | null = null;
    try {
      coverUrl = await fetchJournalCoverMultiSource(journal.name, journal.issn || undefined);
    } catch {
      // 封面获取失败不影响主流程
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

    journalResults.push({
      name: journal.name,
      impactFactor: journal.impactFactor,
      partition: journal.partition,
      coverUrl,
      dataCardUri,
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
