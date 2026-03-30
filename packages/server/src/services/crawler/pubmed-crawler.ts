/**
 * PubMed 医学论文爬虫 —— SCI线（医学专项）
 *
 * 数据源：PubMed E-utilities（免费API）
 * 目的：获取医学领域热门研究方向和投稿热点期刊
 *
 * 员工录音洞察：
 * - "医院的SCI需求量是目前所有行业里面最大的"
 * - "从副高开始到正高，必须发SCI"
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, JournalItem } from "./types.js";

// 医学热门研究方向
const MEDICAL_QUERIES = [
  { query: "cancer immunotherapy", label: "肿瘤免疫治疗" },
  { query: "machine learning diagnosis", label: "AI辅助诊断" },
  { query: "gut microbiome", label: "肠道微生物" },
  { query: "diabetes mellitus", label: "糖尿病研究" },
  { query: "cardiovascular disease", label: "心血管疾病" },
  { query: "traditional chinese medicine", label: "中医药" },
  { query: "nursing care", label: "护理学" },
  { query: "public health policy", label: "公共卫生" },
  { query: "rehabilitation medicine", label: "康复医学" },
  { query: "mental health intervention", label: "心理健康干预" },
];

export class PubMedCrawler implements CrawlerAdapter {
  platform = "pubmed" as const;
  track = "sci" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const journals: JournalItem[] = [];

      // 获取各医学方向30天发文量
      for (const topic of MEDICAL_QUERIES) {
        try {
          const count = await this.searchCount(topic.query);
          journals.push({
            name: `${topic.label} (${topic.query})`,
            discipline: "医学",
            subdiscipline: topic.label,
            annualVolume: count,
            platform: "pubmed",
            url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(topic.query)}&filter=dates.30d`,
            crawledAt: now,
          });
          await new Promise((r) => setTimeout(r, 400));
        } catch {
          // 单个查询失败不影响整体
        }
      }

      // 获取中国作者近7天发文的热门期刊
      try {
        const trendingJournals = await this.fetchChinaAuthorJournals();
        journals.push(...trendingJournals.map((j) => ({ ...j, crawledAt: now })));
      } catch {
        logger.warn("PubMed中国作者期刊数据获取失败");
      }

      journals.sort((a, b) => (b.annualVolume || 0) - (a.annualVolume || 0));

      logger.info({ platform: "pubmed", count: journals.length }, "PubMed数据抓取完成");

      return { platform: "pubmed", track: "sci", keywords: [], journals, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "PubMed抓取失败");
      return { platform: "pubmed", track: "sci", keywords: [], journals: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  private async searchCount(query: string): Promise<number> {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&datetype=edat&reldate=30&rettype=count&retmode=json`;
    const response = await fetch(url);
    if (!response.ok) return 0;
    const data = (await response.json()) as { esearchresult?: { count?: string } };
    return parseInt(data.esearchresult?.count || "0", 10);
  }

  private async fetchChinaAuthorJournals(): Promise<Omit<JournalItem, "crawledAt">[]> {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=China[Affiliation]&datetype=edat&reldate=7&retmax=100&retmode=json`;
    const response = await fetch(url);
    if (!response.ok) return [];

    const data = (await response.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = data.esearchresult?.idlist;
    if (!ids || ids.length === 0) return [];

    const detailUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.slice(0, 50).join(",")}&retmode=json`;
    const detailResponse = await fetch(detailUrl);
    if (!detailResponse.ok) return [];

    const details = (await detailResponse.json()) as {
      result?: Record<string, { source?: string; fulljournalname?: string; essn?: string; issn?: string }>;
    };
    if (!details.result) return [];

    const journalCount = new Map<string, { name: string; issn?: string; count: number }>();
    for (const [key, article] of Object.entries(details.result)) {
      if (key === "uids") continue;
      const journalName = article.fulljournalname || article.source;
      if (!journalName) continue;
      const existing = journalCount.get(journalName.toLowerCase());
      if (existing) existing.count++;
      else journalCount.set(journalName.toLowerCase(), { name: journalName, issn: article.essn || article.issn, count: 1 });
    }

    return Array.from(journalCount.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((j) => ({
        name: j.name,
        issn: j.issn,
        discipline: "医学",
        annualVolume: j.count * 52,
        platform: "pubmed" as const,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(j.name)}[Journal]`,
      }));
  }
}
