/**
 * 百度爬虫 —— 期刊行业定向版
 *
 * 策略变更：不再抓通用热搜，改为：
 * 1. 用期刊行业关键词搜索百度资讯
 * 2. 从百度学术获取期刊领域热点
 * 3. 从通用热搜中过滤出行业相关条目
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

// 期刊代发行业定向搜索词（用于百度资讯搜索）
const JOURNAL_SEARCH_TERMS = [
  "SCI期刊 最新", "SSCI期刊 发表",
  "期刊预警名单 2025", "期刊预警名单 2026",
  "中科院分区 调整", "JCR影响因子",
  "论文发表 攻略", "SCI投稿 经验",
  "核心期刊 目录", "北大核心 最新",
  "南大核心 CSSCI", "CSCD 目录",
  "国自然 基金", "课题申报 2026",
  "学术不端 撤稿", "论文查重 标准",
  "考研 复试", "考博 申请",
  "审稿周期 快", "SCI润色",
  "期刊推荐 选刊", "影响因子 排名",
  "开放获取 OA期刊", "掠夺性期刊",
];

// 行业过滤关键词
const INDUSTRY_FILTER_WORDS = [
  "论文", "期刊", "SCI", "SSCI", "EI", "核心", "发表", "投稿",
  "审稿", "影响因子", "分区", "学术", "科研", "博士", "硕士",
  "导师", "学位", "基金", "课题", "查重", "撤稿", "预警",
  "考研", "考博", "保研", "高校", "学报", "知网", "万方",
  "JCR", "CSCD", "CSSCI", "北大核心", "南大核心", "开题", "答辩",
];

export class BaiduCrawler implements CrawlerAdapter {
  platform = "baidu" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const items: RawHotItem[] = [];

      // 策略1：用行业关键词搜索百度资讯，提取热点
      for (const term of JOURNAL_SEARCH_TERMS) {
        try {
          const newsItems = await this.searchBaiduNews(term, now);
          items.push(...newsItems);
          await new Promise((r) => setTimeout(r, 600));
        } catch {
          // 单个搜索失败不影响整体
        }
      }

      // 策略2：从通用百度热搜中过滤出行业相关条目
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
        { platform: "baidu", count: top100.length },
        "百度期刊行业热点抓取完成"
      );

      return { platform: "baidu", items: top100, success: true, crawledAt: now };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "baidu", error: errorMsg }, "百度抓取失败");
      return { platform: "baidu", items: [], success: false, error: errorMsg, crawledAt: now };
    }
  }

  /** 搜索百度资讯 */
  private async searchBaiduNews(term: string, now: string): Promise<RawHotItem[]> {
    // 百度资讯搜索（公开页面）
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(term)}&tn=news&rtt=4&bsst=1&cl=2&medium=0`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
        Referer: "https://www.baidu.com/",
      },
    });

    if (!response.ok) return [];

    const html = await response.text();

    // 从搜索结果页面提取标题（简单正则，非完美但够用）
    const titleRegex = /<h3[^>]*class="news-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi;
    const results: RawHotItem[] = [];
    let match;

    while ((match = titleRegex.exec(html)) !== null) {
      const title = match[1]
        .replace(/<[^>]+>/g, "") // 去掉HTML标签
        .replace(/&[a-z]+;/g, "") // 去掉HTML实体
        .trim();

      if (title.length > 5 && title.length < 200) {
        results.push({
          keyword: title,
          heatScore: 200 - results.length * 10, // 按排名递减
          platform: "baidu",
          rank: results.length + 1,
          description: `百度资讯搜索: ${term}`,
          crawledAt: now,
        });
      }

      if (results.length >= 5) break; // 每个搜索词取前5条
    }

    // 如果正则没匹配到，直接用搜索词本身作为关键词（保底）
    if (results.length === 0) {
      results.push({
        keyword: term,
        heatScore: 100,
        platform: "baidu",
        rank: 1,
        description: "百度定向搜索词",
        crawledAt: now,
      });
    }

    return results;
  }

  /** 从通用百度热搜中过滤出期刊行业相关条目 */
  private async fetchFilteredHotSearch(now: string): Promise<RawHotItem[]> {
    const response = await fetch(
      "https://top.baidu.com/api/board?platform=wise&tab=realtime",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://top.baidu.com/board",
        },
      }
    );

    if (!response.ok) return [];

    const json = (await response.json()) as {
      data?: {
        cards?: Array<{
          content?: Array<{
            word?: string;
            desc?: string;
            hotScore?: string;
            url?: string;
          }>;
        }>;
      };
    };

    const cards = json?.data?.cards;
    if (!cards) return [];

    const items: RawHotItem[] = [];

    for (const card of cards) {
      if (!card.content) continue;
      for (const item of card.content) {
        if (!item.word) continue;

        // 只保留命中行业关键词的热搜
        const lower = item.word.toLowerCase();
        const isRelevant = INDUSTRY_FILTER_WORDS.some((fw) =>
          lower.includes(fw.toLowerCase())
        );
        if (!isRelevant) continue;

        items.push({
          keyword: item.word.trim(),
          heatScore: parseInt(item.hotScore || "0", 10),
          platform: "baidu",
          url: item.url,
          description: `百度热搜(行业过滤): ${item.desc || ""}`,
          crawledAt: now,
        });
      }
    }

    return items;
  }
}
