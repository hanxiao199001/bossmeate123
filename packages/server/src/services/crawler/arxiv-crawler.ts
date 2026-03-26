/**
 * arXiv 学术预印本爬虫 —— 期刊行业定向版
 *
 * 数据源：arXiv（计算机/物理/数学/生物等预印本）
 * 策略变更：聚焦期刊代发行业关注的热门投稿方向：
 * 1. 各学科近期最热论文标题（反映投稿趋势）
 * 2. 强调"可转化为期刊投稿"的研究方向
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 期刊代发行业关注的arXiv学科分类（偏向中国作者常投的领域）
const ARXIV_CATEGORIES = [
  { code: "cs.AI", label: "人工智能" },
  { code: "cs.CL", label: "自然语言处理" },
  { code: "cs.CV", label: "计算机视觉" },
  { code: "cs.LG", label: "机器学习" },
  { code: "q-bio", label: "定量生物学" },
  { code: "physics.med-ph", label: "医学物理" },
  { code: "stat.ML", label: "统计机器学习" },
  { code: "eess.SP", label: "信号处理" },
  { code: "cs.SE", label: "软件工程" },
  { code: "cs.DB", label: "数据库" },
];

export class ArxivCrawler implements CrawlerAdapter {
  platform = "arxiv" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      for (const category of ARXIV_CATEGORIES) {
        try {
          const papers = await this.fetchRecentPapers(category.code);

          for (const paper of papers) {
            items.push({
              keyword: `${category.label}投稿热点：${paper.title.slice(0, 80)}`,
              heatScore: 500 - items.length,
              platform: "arxiv",
              rank: items.length + 1,
              url: paper.link,
              description: `${category.label} | ${paper.published} | ${paper.authors.slice(0, 3).join(", ")} | arXiv预印本→可转期刊投稿`,
              crawledAt: now,
            });
          }

          // arXiv API 要求请求间隔至少3秒
          await new Promise((r) => setTimeout(r, 3000));
        } catch {
          // 单个分类失败不影响整体
        }
      }

      // 去重
      const seen = new Set<string>();
      const unique = items.filter((item) => {
        const key = item.keyword.toLowerCase().slice(0, 50);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const top50 = unique.slice(0, 50);

      logger.info(
        { platform: "arxiv", count: top50.length },
        "arXiv 期刊行业热点抓取完成"
      );

      return { platform: "arxiv", items: top50, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "arxiv", error: errorMsg }, "arXiv 抓取失败");
      return { platform: "arxiv", items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 获取某分类的最新论文 */
  private async fetchRecentPapers(
    category: string
  ): Promise<Array<{ title: string; link: string; published: string; authors: string[] }>> {
    const url = `https://export.arxiv.org/api/query?search_query=cat:${category}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`arXiv API: ${response.status}`);

    const xml = await response.text();

    const entries = xml.split("<entry>").slice(1);
    const papers: Array<{
      title: string;
      link: string;
      published: string;
      authors: string[];
    }> = [];

    for (const entry of entries) {
      const title = this.extractXmlTag(entry, "title")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const link = this.extractXmlAttribute(entry, "link", "href") || "";
      const published = this.extractXmlTag(entry, "published").split("T")[0];

      const authorMatches = entry.match(/<name>([^<]+)<\/name>/g) || [];
      const authors = authorMatches.map((a) =>
        a.replace(/<\/?name>/g, "").trim()
      );

      if (title && title.length > 10) {
        papers.push({ title, link, published, authors });
      }
    }

    return papers;
  }

  private extractXmlTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
    const match = xml.match(regex);
    return match ? match[1].trim() : "";
  }

  private extractXmlAttribute(
    xml: string,
    tag: string,
    attr: string
  ): string | null {
    const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  }
}
