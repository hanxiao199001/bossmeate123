/**
 * arXiv 预印本爬虫 —— SCI线（计算机/物理/数学专项）
 *
 * 数据源：arXiv API（免费、稳定）
 * 目的：获取计算机/物理等领域最新研究趋势，辅助SCI选题
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, JournalItem } from "./types.js";

const ARXIV_CATEGORIES = [
  { code: "cs.AI", label: "人工智能", discipline: "计算机" },
  { code: "cs.CL", label: "自然语言处理", discipline: "计算机" },
  { code: "cs.CV", label: "计算机视觉", discipline: "计算机" },
  { code: "cs.LG", label: "机器学习", discipline: "计算机" },
  { code: "q-bio", label: "定量生物学", discipline: "生物学" },
  { code: "physics.med-ph", label: "医学物理", discipline: "医学" },
  { code: "eess.SP", label: "信号处理", discipline: "工程技术" },
  { code: "cs.SE", label: "软件工程", discipline: "计算机" },
  { code: "stat.ML", label: "统计机器学习", discipline: "计算机" },
];

export class ArxivCrawler implements CrawlerAdapter {
  platform = "arxiv" as const;
  track = "sci" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const journals: JournalItem[] = [];

      for (const category of ARXIV_CATEGORIES) {
        try {
          const papers = await this.fetchRecentPapers(category.code);
          for (const paper of papers) {
            journals.push({
              name: `[${category.label}] ${paper.title.slice(0, 80)}`,
              discipline: category.discipline,
              subdiscipline: category.label,
              url: paper.link,
              platform: "arxiv",
              crawledAt: now,
            });
          }
          await new Promise((r) => setTimeout(r, 3000)); // arXiv要求3s间隔
        } catch {
          // 单个分类失败不影响整体
        }
      }

      logger.info({ platform: "arxiv", count: journals.length }, "arXiv数据抓取完成");

      return { platform: "arxiv", track: "sci", keywords: [], journals, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "arXiv抓取失败");
      return { platform: "arxiv", track: "sci", keywords: [], journals: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  private async fetchRecentPapers(category: string): Promise<Array<{ title: string; link: string }>> {
    const url = `https://export.arxiv.org/api/query?search_query=cat:${category}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`arXiv API: ${response.status}`);

    const xml = await response.text();
    const entries = xml.split("<entry>").slice(1);
    const papers: Array<{ title: string; link: string }> = [];

    for (const entry of entries) {
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
      const title = titleMatch ? titleMatch[1].replace(/\n/g, " ").replace(/\s+/g, " ").trim() : "";
      const link = linkMatch ? linkMatch[1].trim() : "";
      if (title.length > 10) papers.push({ title, link });
    }

    return papers;
  }
}
