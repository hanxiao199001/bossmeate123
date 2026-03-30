/**
 * OpenAlex 学术数据爬虫 —— SCI线
 *
 * 数据源：OpenAlex（全球最大开放学术数据库，免费API）
 * 目的：补充LetPub数据，获取期刊实时发文量、引用趋势
 *
 * 策略：
 * 1. 按三大核心领域（医学/能源/计算机）获取高发文量期刊
 * 2. 获取中国作者近期高引论文所在期刊（精准匹配客户投稿目标）
 * 3. 输出标准 JournalItem 格式，可直接入库
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, JournalItem, HotKeywordItem } from "./types.js";
import { LETPUB_DISCIPLINES } from "./types.js";

// OpenAlex 学科映射（concept ID）
const OPENALEX_FIELDS = [
  { concept: "C71924100", label: "医学", code: "medicine" },
  { concept: "C127313418", label: "能源", code: "energy" },
  { concept: "C41008148", label: "计算机", code: "computer" },
  { concept: "C127413603", label: "工程技术", code: "engineering" },
  { concept: "C162324750", label: "经济管理", code: "economics" },
  { concept: "C86803240", label: "生物学", code: "biology" },
  { concept: "C185592680", label: "化学", code: "chemistry" },
  { concept: "C121332964", label: "物理", code: "physics" },
  { concept: "C192562407", label: "材料科学", code: "materials" },
  { concept: "C39432304", label: "环境科学", code: "environment" },
];

const OPENALEX_EMAIL = "bossmate@example.com";

export class OpenAlexCrawler implements CrawlerAdapter {
  platform = "openalex" as const;
  track = "sci" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const journals: JournalItem[] = [];

      // 1. 按学科获取高发文量期刊（这些是客户真正会投的期刊）
      for (const field of OPENALEX_FIELDS) {
        try {
          const sources = await this.fetchTopJournals(field.concept);
          for (const source of sources) {
            journals.push({
              name: source.display_name,
              issn: source.issn?.[0],
              discipline: field.label,
              impactFactor: source.summary_stats?.["2yr_mean_citedness"],
              annualVolume: source.works_count,
              isOA: source.is_oa || false,
              url: source.homepage_url || `https://openalex.org/sources/${source.id?.split("/").pop()}`,
              platform: "openalex",
              crawledAt: now,
            });
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          // 单个领域失败不影响整体
        }
      }

      // 2. 获取中国作者近30天高引论文所在期刊
      try {
        const chinaJournals = await this.fetchChinaAuthorJournals();
        journals.push(
          ...chinaJournals.map((j) => ({ ...j, crawledAt: now }))
        );
      } catch {
        logger.warn("OpenAlex 中国作者期刊数据获取失败");
      }

      // 去重
      const seen = new Set<string>();
      const unique = journals.filter((j) => {
        const key = (j.issn || j.name).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      logger.info(
        { platform: "openalex", count: unique.length },
        "OpenAlex 期刊数据抓取完成"
      );

      return {
        platform: "openalex",
        track: "sci",
        keywords: [],
        journals: unique,
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "OpenAlex 抓取失败");
      return {
        platform: "openalex",
        track: "sci",
        keywords: [],
        journals: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }

  /** 获取某学科高发文量期刊 TOP 10 */
  private async fetchTopJournals(conceptId: string) {
    const url = `https://api.openalex.org/sources?filter=type:journal,concepts.id:${conceptId}&sort=works_count:desc&per_page=10&mailto=${OPENALEX_EMAIL}`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        display_name: string;
        issn?: string[];
        works_count: number;
        cited_by_count: number;
        homepage_url?: string;
        is_oa?: boolean;
        summary_stats?: { "2yr_mean_citedness"?: number };
      }>;
    };

    return data.results || [];
  }

  /** 获取中国作者近期高引论文，提取所在期刊 */
  private async fetchChinaAuthorJournals(): Promise<Omit<JournalItem, "crawledAt">[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .split("T")[0];

    const url = `https://api.openalex.org/works?filter=from_publication_date:${thirtyDaysAgo},authorships.countries:CN&sort=cited_by_count:desc&per_page=30&mailto=${OPENALEX_EMAIL}`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      results: Array<{
        primary_location?: {
          source?: {
            display_name: string;
            issn?: string[];
            is_oa?: boolean;
            host_organization_name?: string;
          };
        };
        cited_by_count: number;
        concepts?: Array<{ display_name: string; level: number }>;
      }>;
    };

    const journalMap = new Map<string, Omit<JournalItem, "crawledAt">>();

    for (const work of data.results || []) {
      const source = work.primary_location?.source;
      if (!source?.display_name) continue;

      const key = source.display_name.toLowerCase();
      if (journalMap.has(key)) continue;

      // 从论文的概念标签推断学科
      const topConcept = work.concepts?.find((c) => c.level === 0);
      const discipline = topConcept?.display_name || "综合";

      journalMap.set(key, {
        name: source.display_name,
        issn: source.issn?.[0],
        discipline: this.mapDiscipline(discipline),
        isOA: source.is_oa || false,
        url: `https://openalex.org/sources`,
        platform: "openalex",
      });
    }

    return Array.from(journalMap.values());
  }

  /** 将 OpenAlex 学科名映射到我们的标准分类 */
  private mapDiscipline(openalexName: string): string {
    const lower = openalexName.toLowerCase();
    if (/medicine|health|clinical|nurs/i.test(lower)) return "医学";
    if (/energy|fuel|power/i.test(lower)) return "能源";
    if (/computer|software|artificial/i.test(lower)) return "计算机";
    if (/engineer/i.test(lower)) return "工程技术";
    if (/econom|business|management|finance/i.test(lower)) return "经济管理";
    if (/bio|cell|gene/i.test(lower)) return "生物学";
    if (/chem/i.test(lower)) return "化学";
    if (/physic/i.test(lower)) return "物理";
    if (/material/i.test(lower)) return "材料科学";
    if (/environment|ecology/i.test(lower)) return "环境科学";
    if (/agri|food|plant/i.test(lower)) return "农林科学";
    if (/psych/i.test(lower)) return "心理学";
    if (/education|learn/i.test(lower)) return "教育学";
    return "综合";
  }
}
