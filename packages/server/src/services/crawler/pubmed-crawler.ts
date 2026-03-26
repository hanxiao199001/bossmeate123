/**
 * PubMed 医学期刊爬虫 —— 期刊行业定向版
 *
 * 数据源：PubMed/NCBI E-utilities
 * 策略变更：聚焦期刊代发行业关注的医学发表趋势：
 * 1. 各医学子领域近期论文发表量（反映投稿热度）
 * 2. 热门医学期刊的发文趋势
 * 3. 中国作者在医学领域的发表情况
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 期刊代发行业重点关注的医学研究方向（中国市场热门投稿方向）
const JOURNAL_FOCUSED_QUERIES = [
  { query: "artificial intelligence medicine 2025", label: "AI医学应用" },
  { query: "gene therapy clinical trial 2025", label: "基因治疗" },
  { query: "immunotherapy cancer", label: "肿瘤免疫治疗" },
  { query: "traditional chinese medicine", label: "中医药研究" },
  { query: "nursing research", label: "护理学研究" },
  { query: "rehabilitation medicine", label: "康复医学" },
  { query: "public health China", label: "公共卫生" },
  { query: "medical education", label: "医学教育" },
  { query: "clinical pharmacy", label: "临床药学" },
  { query: "medical imaging AI", label: "医学影像AI" },
  { query: "mental health intervention", label: "心理健康干预" },
  { query: "gut microbiome", label: "肠道微生物组" },
  { query: "precision medicine", label: "精准医学" },
  { query: "stem cell therapy", label: "干细胞治疗" },
  { query: "meta-analysis systematic review", label: "Meta分析/系统综述" },
  { query: "randomized controlled trial", label: "随机对照试验RCT" },
  { query: "biomarker diagnosis", label: "生物标志物诊断" },
  { query: "minimally invasive surgery", label: "微创手术" },
  { query: "cardiovascular prevention", label: "心血管疾病预防" },
  { query: "diabetes management", label: "糖尿病管理" },
];

export class PubMedCrawler implements CrawlerAdapter {
  platform = "pubmed" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 策略：对每个热门医学方向，获取近期论文数量作为投稿热度指标
      for (const { query, label } of JOURNAL_FOCUSED_QUERIES) {
        try {
          const count = await this.searchRecentCount(query);
          if (count > 0) {
            items.push({
              keyword: `医学热门方向：${label}`,
              heatScore: count,
              platform: "pubmed",
              rank: items.length + 1,
              url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(query)}&filter=dates.2024-2026`,
              description: `PubMed 近2年论文数: ${count.toLocaleString()} | 投稿热度参考`,
              crawledAt: now,
            });
          }
          // PubMed API 限制：每秒最多3次请求
          await new Promise((r) => setTimeout(r, 350));
        } catch {
          // 单个查询失败不影响整体
        }
      }

      // 获取 PubMed 近期高影响力论文（期刊从业者关注的内容）
      try {
        const trendingItems = await this.fetchTrendingArticles(now);
        items.push(...trendingItems);
      } catch {
        // trending 失败不影响整体
      }

      items.sort((a, b) => b.heatScore - a.heatScore);
      const top50 = items.slice(0, 50);

      logger.info(
        { platform: "pubmed", count: top50.length },
        "PubMed 期刊行业热点抓取完成"
      );

      return { platform: "pubmed", items: top50, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "pubmed", error: errorMsg }, "PubMed 抓取失败");
      return { platform: "pubmed", items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 搜索某个关键词近2年的论文数量 */
  private async searchRecentCount(query: string): Promise<number> {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&datetype=pdat&mindate=2024/01/01&retmax=0&retmode=json`;

    const res = await fetch(url);
    if (!res.ok) return 0;

    const data = (await res.json()) as {
      esearchresult?: { count?: string };
    };

    return parseInt(data.esearchresult?.count || "0", 10);
  }

  /** 获取近期高影响力论文标题（对接期刊选题） */
  private async fetchTrendingArticles(now: string): Promise<RawHotItem[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const minDate = `${thirtyDaysAgo.getFullYear()}/${String(thirtyDaysAgo.getMonth() + 1).padStart(2, "0")}/${String(thirtyDaysAgo.getDate()).padStart(2, "0")}`;

    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=*&retmax=15&sort=relevance&datetype=pdat&mindate=${minDate}&retmode=json`;

    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];

    const searchData = (await searchRes.json()) as {
      esearchresult?: { idlist?: string[] };
    };

    const ids = searchData.esearchresult?.idlist;
    if (!ids || ids.length === 0) return [];

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

        const title = article.title.replace(/<\/?[^>]+(>|$)/g, "").slice(0, 150);
        items.push({
          keyword: `${article.source}期刊：${title}`,
          heatScore: 800 - items.length * 50,
          platform: "pubmed",
          rank: items.length + 1,
          url: `https://pubmed.ncbi.nlm.nih.gov/${article.uid}/`,
          description: `期刊: ${article.source} | ${article.pubdate}`,
          crawledAt: now,
        });
      }
    }

    return items;
  }
}
