/**
 * 微博爬虫 —— 期刊行业定向版
 *
 * 策略变更：不再抓通用热搜，改为：
 * 1. 用期刊行业关键词搜索微博话题/超话
 * 2. 只保留与学术期刊代发行业相关的内容
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 期刊代发行业定向搜索词
const JOURNAL_SEARCH_TERMS = [
  "SCI期刊", "SCI论文", "SSCI期刊", "EI论文",
  "期刊预警", "期刊降区", "期刊分区", "影响因子",
  "中科院分区", "JCR分区", "期刊黑名单",
  "论文发表", "论文投稿", "论文代发", "论文润色",
  "审稿周期", "审稿意见", "拒稿", "退修",
  "核心期刊", "北大核心", "南大核心", "CSCD", "CSSCI",
  "考研", "考博", "保研", "学术不端", "撤稿", "查重",
  "基金申请", "国自然", "课题申报", "开题报告",
  "学术会议", "论文写作", "文献综述", "Meta分析",
  "SCI写作", "英文润色", "期刊推荐", "选刊",
];

// 行业过滤关键词（微博热搜中命中任一则保留）
const INDUSTRY_FILTER_WORDS = [
  "论文", "期刊", "SCI", "SSCI", "EI", "核心", "发表", "投稿",
  "审稿", "影响因子", "分区", "学术", "科研", "博士", "硕士",
  "导师", "学位", "基金", "课题", "查重", "撤稿", "预警",
  "考研", "考博", "保研", "高校", "Nature", "Science", "Lancet",
  "知网", "万方", "维普", "JCR", "LetPub", "中科院",
  "开题", "答辩", "学报", "CSCD", "CSSCI", "北大核心", "南大核心",
];

export class WeiboCrawler implements CrawlerAdapter {
  platform = "weibo" as const;
  track = "social" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 策略1：用行业关键词搜索微博话题
      for (const term of JOURNAL_SEARCH_TERMS) {
        try {
          const topicItems = await this.searchTopic(term, now);
          items.push(...topicItems);
          // 控制请求频率
          await new Promise((r) => setTimeout(r, 500));
        } catch {
          // 单个搜索失败不影响整体
        }
      }

      // 策略2：从通用热搜中过滤出行业相关条目
      try {
        const filteredHot = await this.fetchFilteredHotSearch(now);
        items.push(...filteredHot);
      } catch {
        // 热搜过滤失败不影响整体
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
        { platform: "weibo", count: top100.length, searched: JOURNAL_SEARCH_TERMS.length },
        "微博期刊行业热点抓取完成"
      );

      return { platform: "weibo", keywords: [], journals: [], items: top100, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "weibo", error: errorMsg }, "微博抓取失败");
      return { platform: "weibo", keywords: [], journals: [], items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 搜索微博话题 */
  private async searchTopic(term: string, now: string): Promise<RawHotItem[]> {
    const url = `https://m.s.weibo.com/ajax_topic/trend?q=${encodeURIComponent(term)}&time=24h`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        Accept: "application/json",
        Referer: "https://m.s.weibo.com/",
      },
    });

    if (!response.ok) return [];

    // 即使API返回非JSON，也要安全处理
    try {
      const json = (await response.json()) as {
        data?: {
          trend_list?: Array<{
            word?: string;
            num?: number;
            rank?: number;
          }>;
        };
      };

      if (!json.data?.trend_list) return [];

      return json.data.trend_list
        .filter((item) => item.word)
        .map((item, idx) => ({
          keyword: item.word!.trim(),
          heatScore: item.num || 100,
          platform: "weibo" as const,
          rank: idx + 1,
          description: `微博话题搜索: ${term}`,
          crawledAt: now,
        }));
    } catch {
      return [];
    }
  }

  /** 从通用热搜中过滤出期刊行业相关条目 */
  private async fetchFilteredHotSearch(now: string): Promise<RawHotItem[]> {
    const response = await fetch(
      "https://weibo.com/ajax/side/hotSearch",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://weibo.com/",
        },
      }
    );

    if (!response.ok) return [];

    const json = (await response.json()) as {
      ok?: number;
      data?: {
        realtime?: Array<{
          word?: string;
          num?: number;
          rank?: number;
          note?: string;
        }>;
      };
    };

    if (json.ok !== 1 || !json.data?.realtime) return [];

    // 只保留命中行业关键词的热搜
    return json.data.realtime
      .filter((item) => {
        if (!item.word) return false;
        const lower = item.word.toLowerCase();
        return INDUSTRY_FILTER_WORDS.some((fw) => lower.includes(fw.toLowerCase()));
      })
      .map((item, idx) => ({
        keyword: item.word!.trim(),
        heatScore: item.num || 0,
        platform: "weibo" as const,
        rank: idx + 1,
        description: `微博热搜(行业过滤)`,
        crawledAt: now,
      }));
  }
}
