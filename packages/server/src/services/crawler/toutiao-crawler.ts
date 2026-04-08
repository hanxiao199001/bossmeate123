/**
 * 头条爬虫 —— 期刊行业定向版
 *
 * 策略变更：不再抓通用热搜，改为：
 * 1. 用期刊行业关键词搜索头条资讯
 * 2. 从通用热榜中过滤出行业相关条目
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 期刊代发行业定向搜索词
const JOURNAL_SEARCH_TERMS = [
  "SCI期刊", "SSCI期刊", "EI论文",
  "核心期刊发表", "影响因子排名",
  "期刊预警", "期刊分区调整",
  "论文投稿经验", "论文发表技巧",
  "审稿意见回复", "论文查重",
  "考研", "考博", "保研",
  "国自然基金", "科研基金申请",
  "学术不端", "撤稿事件",
  "博士论文写作", "SCI论文写作",
  "学术会议", "期刊推荐",
];

// 行业过滤关键词
const INDUSTRY_FILTER_WORDS = [
  "论文", "期刊", "SCI", "SSCI", "EI", "核心", "发表", "投稿",
  "审稿", "影响因子", "分区", "学术", "科研", "博士", "硕士",
  "导师", "学位", "基金", "课题", "查重", "撤稿", "预警",
  "考研", "考博", "保研", "高校", "大学", "学报",
  "知网", "JCR", "CSCD", "CSSCI", "开题", "答辩",
];

export class ToutiaoCrawler implements CrawlerAdapter {
  platform = "toutiao" as const;
  track = "social" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 策略1：用行业关键词搜索头条资讯
      for (const term of JOURNAL_SEARCH_TERMS) {
        try {
          const searchItems = await this.searchToutiao(term, now);
          items.push(...searchItems);
          await new Promise((r) => setTimeout(r, 500));
        } catch {
          // 单个搜索失败不影响整体
        }
      }

      // 策略2：从通用热榜中过滤出行业相关条目
      try {
        const filteredHot = await this.fetchFilteredHotBoard(now);
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
        { platform: "toutiao", count: top100.length },
        "头条期刊行业热点抓取完成"
      );

      return { platform: "toutiao", keywords: [], journals: [], items: top100, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "toutiao", error: errorMsg }, "头条抓取失败");
      return { platform: "toutiao", keywords: [], journals: [], items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 搜索头条资讯 */
  private async searchToutiao(term: string, now: string): Promise<RawHotItem[]> {
    const url = `https://so.toutiao.com/search?dvpf=pc&source=input&keyword=${encodeURIComponent(term)}&pd=information&action_type=search_subtab_switch&page_num=0&search_id=`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
        Referer: "https://www.toutiao.com/",
      },
    });

    if (!response.ok) return [];

    const html = await response.text();

    // 提取搜索结果标题
    const titleRegex = /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    const results: RawHotItem[] = [];
    let match;

    while ((match = titleRegex.exec(html)) !== null) {
      const title = match[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z]+;/g, "")
        .trim();

      if (title.length > 5 && title.length < 200) {
        results.push({
          keyword: title,
          heatScore: 150 - results.length * 10,
          platform: "toutiao",
          rank: results.length + 1,
          description: `头条搜索: ${term}`,
          crawledAt: now,
        });
      }

      if (results.length >= 5) break;
    }

    // 保底：如果没有匹配到搜索结果，用搜索词本身
    if (results.length === 0) {
      results.push({
        keyword: term,
        heatScore: 80,
        platform: "toutiao",
        rank: 1,
        description: "头条定向搜索词",
        crawledAt: now,
      });
    }

    return results;
  }

  /** 从通用热榜中过滤出期刊行业相关条目 */
  private async fetchFilteredHotBoard(now: string): Promise<RawHotItem[]> {
    const response = await fetch(
      "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://www.toutiao.com/",
        },
      }
    );

    if (!response.ok) return [];

    const json = (await response.json()) as {
      data?: Array<{
        Title?: string;
        HotValue?: string;
        Url?: string;
      }>;
    };

    if (!json.data) return [];

    // 只保留命中行业关键词的热榜
    return json.data
      .filter((item) => {
        if (!item.Title) return false;
        const lower = item.Title.toLowerCase();
        return INDUSTRY_FILTER_WORDS.some((fw) =>
          lower.includes(fw.toLowerCase())
        );
      })
      .map((item, idx) => ({
        keyword: item.Title!.trim(),
        heatScore: parseInt(item.HotValue || "0", 10),
        platform: "toutiao" as const,
        rank: idx + 1,
        url: item.Url,
        description: "头条热榜(行业过滤)",
        crawledAt: now,
      }));
  }
}
