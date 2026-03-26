/**
 * 知乎热榜爬虫
 *
 * 数据源：知乎热榜（公开API）
 * 抓取内容：热门话题 + 热度值
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

export class ZhihuCrawler implements CrawlerAdapter {
  platform = "zhihu" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const response = await fetch(
        "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=100",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://www.zhihu.com/hot",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as {
        data?: Array<{
          target?: {
            title?: string;
            excerpt?: string;
            url?: string;
          };
          detail_text?: string; // "xxx 万热度"
          rank?: number;
        }>;
      };

      if (!json.data) {
        throw new Error("知乎热榜返回数据格式异常");
      }

      const items: RawHotItem[] = json.data
        .filter((item) => item.target?.title)
        .map((item, idx) => {
          // 从 detail_text 提取热度数字，如 "2345 万热度" → 23450000
          let heat = 0;
          if (item.detail_text) {
            const match = item.detail_text.match(/([\d.]+)\s*万/);
            if (match) {
              heat = Math.round(parseFloat(match[1]) * 10000);
            } else {
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
            description: item.target?.excerpt,
            crawledAt: now,
          };
        });

      const top100 = items.slice(0, 100);

      logger.info(
        { platform: "zhihu", count: top100.length },
        "知乎热榜抓取完成"
      );

      return {
        platform: "zhihu",
        items: top100,
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "zhihu", error: errorMsg }, "知乎热榜抓取失败");

      return {
        platform: "zhihu",
        items: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }
}
