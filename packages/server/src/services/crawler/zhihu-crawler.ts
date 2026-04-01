/**
 * 知乎爬虫 —— 期刊行业定向版
 *
 * 策略变更：不再抓通用热榜，改为：
 * 1. 搜索知乎上与学术期刊相关的热门问题/话题
 * 2. 从通用热榜中过滤出行业相关条目
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 知乎搜索：期刊行业定向搜索词
const JOURNAL_SEARCH_TERMS = [
  "SCI期刊推荐", "SCI论文投稿", "SSCI期刊",
  "核心期刊发表", "影响因子", "期刊分区",
  "论文发表经验", "审稿周期", "拒稿经验",
  "考研经验", "考博经验", "博士论文",
  "国自然申请", "基金申报", "课题申请",
  "学术不端", "论文查重", "撤稿",
  "期刊预警", "掠夺性期刊", "OA期刊",
  "学术写作", "SCI写作", "文献综述怎么写",
  "Meta分析", "论文润色", "选刊技巧",
  "北大核心", "南大核心", "CSSCI",
];

// 行业过滤关键词
const INDUSTRY_FILTER_WORDS = [
  "论文", "期刊", "SCI", "SSCI", "EI", "核心", "发表", "投稿",
  "审稿", "影响因子", "分区", "学术", "科研", "博士", "硕士",
  "导师", "学位", "基金", "课题", "查重", "撤稿", "预警",
  "考研", "考博", "保研", "高校", "大学", "学报",
  "知网", "万方", "JCR", "CSCD", "CSSCI", "开题", "答辩",
  "Nature", "Science", "Lancet", "Cell",
];

export class ZhihuCrawler implements CrawlerAdapter {
  platform = "zhihu" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 策略1：用行业关键词搜索知乎话题
      for (const term of JOURNAL_SEARCH_TERMS) {
        try {
          const searchItems = await this.searchZhihu(term, now);
          items.push(...searchItems);
          await new Promise((r) => setTimeout(r, 500));
        } catch {
          // 单个搜索失败不影响整体
        }
      }

      // 策略2：从通用热榜中过滤出行业相关条目
      try {
        const filteredHot = await this.fetchFilteredHotList(now);
        items.push(...filteredHot);
      } catch {
        // 热榜过滤失败不影响整体
      }

      // 去重
      const seen = new Set<string>();
      const unique = items.filter((item) => {
        const key = item.keyword.toLowerCase().replace(/\s+/g, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.heatScore - a.heatScore);
      const top100 = unique.slice(0, 100);

      logger.info(
        { platform: "zhihu", count: top100.length },
        "知乎期刊行业热点抓取完成"
      );

      return { platform: "zhihu", keywords: [], journals: [], items: top100, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "zhihu", error: errorMsg }, "知乎抓取失败");
      return { platform: "zhihu", keywords: [], journals: [], items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 搜索知乎问题 */
  private async searchZhihu(term: string, now: string): Promise<RawHotItem[]> {
    const url = `https://www.zhihu.com/api/v4/search_v3?t=general&q=${encodeURIComponent(term)}&correction=1&offset=0&limit=5&lc_idx=0`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://www.zhihu.com/search?type=content&q=" + encodeURIComponent(term),
      },
    });

    if (!response.ok) return [];

    try {
      const json = (await response.json()) as {
        data?: Array<{
          type?: string;
          object?: {
            title?: string;
            question?: { title?: string };
            excerpt?: string;
            voteup_count?: number;
            url?: string;
          };
        }>;
      };

      if (!json.data) return [];

      const results: RawHotItem[] = [];

      for (const item of json.data) {
        const title =
          item.object?.question?.title ||
          item.object?.title ||
          "";

        // 清理HTML标签
        const cleanTitle = title
          .replace(/<[^>]+>/g, "")
          .replace(/&[a-z]+;/g, "")
          .trim();

        if (cleanTitle.length < 5) continue;

        results.push({
          keyword: cleanTitle,
          heatScore: item.object?.voteup_count || 50,
          platform: "zhihu",
          rank: results.length + 1,
          url: item.object?.url,
          description: `知乎搜索: ${term}`,
          crawledAt: now,
        });

        if (results.length >= 3) break; // 每个搜索词取前3条
      }

      return results;
    } catch {
      return [];
    }
  }

  /** 从通用热榜中过滤出期刊行业相关条目 */
  private async fetchFilteredHotList(now: string): Promise<RawHotItem[]> {
    const response = await fetch(
      "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=100",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://www.zhihu.com/hot",
        },
      }
    );

    if (!response.ok) return [];

    const json = (await response.json()) as {
      data?: Array<{
        target?: {
          title?: string;
          excerpt?: string;
          url?: string;
        };
        detail_text?: string;
      }>;
    };

    if (!json.data) return [];

    // 只保留命中行业关键词的热榜
    return json.data
      .filter((item) => {
        if (!item.target?.title) return false;
        const lower = item.target.title.toLowerCase();
        return INDUSTRY_FILTER_WORDS.some((fw) =>
          lower.includes(fw.toLowerCase())
        );
      })
      .map((item, idx) => {
        let heat = 0;
        if (item.detail_text) {
          const match = item.detail_text.match(/([\d.]+)\s*万/);
          if (match) heat = Math.round(parseFloat(match[1]) * 10000);
          else {
            const numMatch = item.detail_text.match(/([\d]+)/);
            if (numMatch) heat = parseInt(numMatch[1], 10);
          }
        }

        return {
          keyword: item.target!.title!.trim(),
          heatScore: heat,
          platform: "zhihu" as const,
          rank: idx + 1,
          url: item.target?.url,
          description: `知乎热榜(行业过滤)`,
          crawledAt: now,
        };
      });
  }
}
