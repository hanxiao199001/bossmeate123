/**
 * arXiv 学术预印本热点爬虫
 *
 * 数据源：arXiv（计算机/物理/数学/生物等预印本，免费公开API）
 * 策略：获取各学科近期最热门的预印本论文
 * API文档：https://info.arxiv.org/help/api/index.html
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// arXiv 学科分类（聚焦与期刊出版相关的热门领域）
const ARXIV_CATEGORIES = [
  { code: "cs.AI", name: "人工智能" },
  { code: "cs.CL", name: "自然语言处理" },
  { code: "cs.CV", name: "计算机视觉" },
  { code: "cs.LG", name: "机器学习" },
  { code: "q-bio", name: "定量生物学" },
  { code: "physics.med-ph", name: "医学物理" },
  { code: "stat.ML", name: "统计机器学习" },
  { code: "eess.SP", name: "信号处理" },
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
              keyword: paper.title,
              heatScore: 500 - items.length, // arXiv没有引用数，按时间排序
              platform: "arxiv",
              rank: items.length + 1,
              url: paper.link,
              description: `${category.name} | ${paper.published} | ${paper.authors.slice(0, 3).join(", ")}`,
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
        "arXiv 学术热点抓取完成"
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

    // 简单XML解析（arXiv返回Atom格式）
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

  /** 提取XML标签内容 */
  private extractXmlTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
    const match = xml.match(regex);
    return match ? match[1].trim() : "";
  }

  /** 提取XML标签属性 */
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
