/**
 * OpenAlex 学术热点爬虫
 *
 * 数据源：OpenAlex（全球最大开放学术数据库，2.5亿+论文）
 * 策略：查询近30天发表量最多的研究主题（concepts），获取学术热点
 * API文档：https://docs.openalex.org/
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

export class OpenAlexCrawler implements CrawlerAdapter {
  platform = "openalex" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      // 获取近期最热门的学术概念/主题
      // 按论文引用量排序，聚焦中国相关的热门研究领域
      const topics = await this.fetchTrendingTopics();
      const recentWorks = await this.fetchRecentHotWorks();

      const items: RawHotItem[] = [];

      // 从热门主题中提取关键词
      for (const topic of topics) {
        items.push({
          keyword: topic.display_name,
          heatScore: topic.works_count || 0,
          platform: "openalex",
          rank: items.length + 1,
          url: topic.id,
          description: `学术领域 | 论文数: ${topic.works_count} | 引用数: ${topic.cited_by_count}`,
          crawledAt: now,
        });
      }

      // 从近期高引论文中提取关键词
      for (const work of recentWorks) {
        const title = work.title || "";
        if (title.length < 5) continue;

        items.push({
          keyword: title.length > 100 ? title.slice(0, 100) : title,
          heatScore: work.cited_by_count || 0,
          platform: "openalex",
          rank: items.length + 1,
          url: work.doi || work.id,
          description: `高引论文 | 引用: ${work.cited_by_count} | ${work.primary_location?.source?.display_name || ""}`,
          crawledAt: now,
        });
      }

      // 去重并按热度排序
      const seen = new Set<string>();
      const unique = items.filter((item) => {
        const key = item.keyword.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.heatScore - a.heatScore);
      const top50 = unique.slice(0, 50);

      logger.info(
        { platform: "openalex", count: top50.length },
        "OpenAlex 学术热点抓取完成"
      );

      return { platform: "openalex", items: top50, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "openalex", error: errorMsg }, "OpenAlex 抓取失败");
      return { platform: "openalex", items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 获取近期热门学术概念 */
  private async fetchTrendingTopics() {
    // 查询被引用次数最多的学术概念，聚焦近年活跃的
    const url =
      "https://api.openalex.org/topics?sort=works_count:desc&per_page=30&mailto=bossmate@example.com";

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) throw new Error(`OpenAlex topics API: ${response.status}`);

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        display_name: string;
        works_count: number;
        cited_by_count: number;
      }>;
    };

    return data.results || [];
  }

  /** 获取近30天高引用论文 */
  private async fetchRecentHotWorks() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .split("T")[0];

    const url = `https://api.openalex.org/works?filter=from_publication_date:${thirtyDaysAgo}&sort=cited_by_count:desc&per_page=20&mailto=bossmate@example.com`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) throw new Error(`OpenAlex works API: ${response.status}`);

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        doi: string;
        title: string;
        cited_by_count: number;
        primary_location?: { source?: { display_name: string } };
      }>;
    };

    return data.results || [];
  }
}
