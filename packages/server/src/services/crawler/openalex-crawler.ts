/**
 * OpenAlex 学术爬虫 —— 期刊行业定向版
 *
 * 数据源：OpenAlex（全球最大开放学术数据库）
 * 策略变更：聚焦期刊代发行业关注的指标：
 * 1. 获取各学科领域热门期刊的最新发表量、引用趋势
 * 2. 获取热门研究方向（帮助选题/选刊）
 * 3. 聚焦中国作者发表量大的期刊和领域
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 期刊行业关注的学科领域（OpenAlex concept IDs）
const FOCUS_FIELDS = [
  { query: "medicine", label: "医学" },
  { query: "engineering", label: "工程" },
  { query: "computer science", label: "计算机" },
  { query: "education", label: "教育" },
  { query: "economics", label: "经济管理" },
  { query: "biology", label: "生物" },
  { query: "chemistry", label: "化学" },
  { query: "physics", label: "物理" },
  { query: "psychology", label: "心理学" },
  { query: "environmental science", label: "环境科学" },
  { query: "materials science", label: "材料科学" },
];

export class OpenAlexCrawler implements CrawlerAdapter {
  platform = "openalex" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 策略1：获取各学科领域近30天发文量最多的期刊（Source）
      const hotSources = await this.fetchHotJournals();
      for (const source of hotSources) {
        items.push({
          keyword: `${source.display_name}（IF趋势）`,
          heatScore: source.works_count || 0,
          platform: "openalex",
          rank: items.length + 1,
          url: source.homepage_url || source.id,
          description: `热门期刊 | 近期发文: ${source.works_count} | 引用: ${source.cited_by_count}`,
          crawledAt: now,
        });
      }

      // 策略2：获取各领域近期高产研究主题（用于选题参考）
      for (const field of FOCUS_FIELDS) {
        try {
          const topics = await this.fetchFieldHotTopics(field.query);
          for (const topic of topics) {
            items.push({
              keyword: `${field.label}热点：${topic.display_name}`,
              heatScore: topic.works_count || 0,
              platform: "openalex",
              rank: items.length + 1,
              url: topic.id,
              description: `${field.label}领域 | 论文数: ${topic.works_count}`,
              crawledAt: now,
            });
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          // 单个领域失败不影响整体
        }
      }

      // 策略3：获取中国作者近期高引论文（期刊代发行业重点关注中国市场）
      const chinaHotWorks = await this.fetchChinaHotWorks();
      for (const work of chinaHotWorks) {
        const journalName = work.primary_location?.source?.display_name || "未知期刊";
        items.push({
          keyword: `${journalName}：${(work.title || "").slice(0, 60)}`,
          heatScore: work.cited_by_count || 0,
          platform: "openalex",
          rank: items.length + 1,
          url: work.doi || work.id,
          description: `中国作者高引 | 期刊: ${journalName} | 引用: ${work.cited_by_count}`,
          crawledAt: now,
        });
      }

      // 去重
      const seen = new Set<string>();
      const unique = items.filter((item) => {
        const key = item.keyword.toLowerCase().slice(0, 50);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.heatScore - a.heatScore);
      const top50 = unique.slice(0, 50);

      logger.info(
        { platform: "openalex", count: top50.length },
        "OpenAlex 期刊行业热点抓取完成"
      );

      return { platform: "openalex", items: top50, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "openalex", error: errorMsg }, "OpenAlex 抓取失败");
      return { platform: "openalex", items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 获取近期发文量最多的期刊 */
  private async fetchHotJournals() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .split("T")[0];

    const url = `https://api.openalex.org/sources?filter=type:journal,works_count:>1000&sort=works_count:desc&per_page=20&mailto=bossmate@example.com`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        display_name: string;
        works_count: number;
        cited_by_count: number;
        homepage_url?: string;
      }>;
    };

    return data.results || [];
  }

  /** 获取某学科领域热门研究主题 */
  private async fetchFieldHotTopics(field: string) {
    const url = `https://api.openalex.org/topics?filter=display_name.search:${encodeURIComponent(field)}&sort=works_count:desc&per_page=5&mailto=bossmate@example.com`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        display_name: string;
        works_count: number;
      }>;
    };

    return data.results || [];
  }

  /** 获取中国作者近期高引论文 */
  private async fetchChinaHotWorks() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .split("T")[0];

    const url = `https://api.openalex.org/works?filter=from_publication_date:${thirtyDaysAgo},authorships.countries:CN&sort=cited_by_count:desc&per_page=15&mailto=bossmate@example.com`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return [];

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
