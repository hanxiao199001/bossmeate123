/**
 * PubMed 医学学术热点爬虫
 *
 * 数据源：PubMed/NCBI E-utilities（3500万+医学论文，免费公开API）
 * 策略：搜索近期热门医学研究主题，获取最新高频关键词
 * API文档：https://www.ncbi.nlm.nih.gov/books/NBK25497/
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 医学/生命科学热门研究方向（用于搜索最新论文）
const MEDICAL_QUERIES = [
  "artificial intelligence medicine",
  "gene therapy clinical trial",
  "immunotherapy cancer",
  "CRISPR genome editing",
  "mRNA vaccine",
  "gut microbiome",
  "precision medicine",
  "digital health",
  "stem cell therapy",
  "drug discovery AI",
  "mental health intervention",
  "neurodegenerative disease",
  "antimicrobial resistance",
  "cardiovascular prevention",
  "medical imaging deep learning",
];

export class PubMedCrawler implements CrawlerAdapter {
  platform = "pubmed" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 1. 获取 PubMed trending articles（最近高频被访问的文章）
      const trendingItems = await this.fetchTrending();
      items.push(...trendingItems);

      // 2. 对每个热门研究方向，获取最新论文数量作为热度
      for (const query of MEDICAL_QUERIES) {
        try {
          const count = await this.searchCount(query);
          if (count > 0) {
            items.push({
              keyword: this.formatQueryAsKeyword(query),
              heatScore: count,
              platform: "pubmed",
              rank: items.length + 1,
              url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(query)}&filter=dates.2024-2026`,
              description: `PubMed 近2年论文数: ${count}`,
              crawledAt: now,
            });
          }
          // PubMed API 限制：每秒最多3次请求
          await new Promise((r) => setTimeout(r, 350));
        } catch {
          // 单个查询失败不影响整体
        }
      }

      items.sort((a, b) => b.heatScore - a.heatScore);
      const top50 = items.slice(0, 50);

      logger.info(
        { platform: "pubmed", count: top50.length },
        "PubMed 医学热点抓取完成"
      );

      return { platform: "pubmed", items: top50, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "pubmed", error: errorMsg }, "PubMed 抓取失败");
      return { platform: "pubmed", items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 获取 PubMed Trending Articles */
  private async fetchTrending(): Promise<RawHotItem[]> {
    const now = new Date().toISOString();
    // 搜索近30天的高影响力论文
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const minDate = `${thirtyDaysAgo.getFullYear()}/${String(thirtyDaysAgo.getMonth() + 1).padStart(2, "0")}/${String(thirtyDaysAgo.getDate()).padStart(2, "0")}`;

    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=*&retmax=20&sort=relevance&datetype=pdat&mindate=${minDate}&retmode=json`;

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];

    const searchData = (await searchRes.json()) as {
      esearchresult?: { idlist?: string[] };
    };

    const ids = searchData.esearchresult?.idlist;
    if (!ids || ids.length === 0) return [];

    // 获取论文详情
    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const fetchRes = await fetch(fetchUrl);
    if (!fetchRes.ok) return [];

    const fetchData = (await fetchRes.json()) as {
      result?: Record<string, {
        uid: string;
        title: string;
        source: string;
        pubdate: string;
      }>;
    };

    const items: RawHotItem[] = [];

    if (fetchData.result) {
      for (const id of ids) {
        const article = fetchData.result[id];
        if (!article || !article.title) continue;

        items.push({
          keyword: article.title.replace(/<\/?[^>]+(>|$)/g, "").slice(0, 150),
          heatScore: 1000 - items.length * 50, // 按排名递减
          platform: "pubmed",
          rank: items.length + 1,
          url: `https://pubmed.ncbi.nlm.nih.gov/${article.uid}/`,
          description: `${article.source} | ${article.pubdate}`,
          crawledAt: now,
        });
      }
    }

    return items;
  }

  /** 搜索某个关键词近2年的论文数量 */
  private async searchCount(query: string): Promise<number> {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&datetype=pdat&mindate=2024/01/01&retmax=0&retmode=json`;

    const res = await fetch(url);
    if (!res.ok) return 0;

    const data = (await res.json()) as {
      esearchresult?: { count?: string };
    };

    return parseInt(data.esearchresult?.count || "0", 10);
  }

  /** 将英文搜索词格式化为中文关键词 */
  private formatQueryAsKeyword(query: string): string {
    const mapping: Record<string, string> = {
      "artificial intelligence medicine": "AI医学应用",
      "gene therapy clinical trial": "基因治疗临床试验",
      "immunotherapy cancer": "肿瘤免疫治疗",
      "CRISPR genome editing": "CRISPR基因编辑",
      "mRNA vaccine": "mRNA疫苗",
      "gut microbiome": "肠道微生物组",
      "precision medicine": "精准医学",
      "digital health": "数字健康",
      "stem cell therapy": "干细胞治疗",
      "drug discovery AI": "AI药物发现",
      "mental health intervention": "心理健康干预",
      "neurodegenerative disease": "神经退行性疾病",
      "antimicrobial resistance": "抗微生物耐药性",
      "cardiovascular prevention": "心血管疾病预防",
      "medical imaging deep learning": "医学影像深度学习",
    };
    return mapping[query] || query;
  }
}
