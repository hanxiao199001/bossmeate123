/**
 * 百度热搜爬虫
 *
 * 数据源：百度热搜榜（公开API，无需登录）
 * 抓取内容：热搜关键词 + 热度值 + 排名
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

export class BaiduCrawler implements CrawlerAdapter {
  platform = "baidu" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      // 百度热搜 JSON API（公开接口）
      const response = await fetch(
        "https://top.baidu.com/api/board?platform=wise&tab=realtime",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://top.baidu.com/board",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as {
        data?: {
          cards?: Array<{
            content?: Array<{
              word?: string;
              desc?: string;
              hotScore?: string;
              index?: number;
              url?: string;
            }>;
          }>;
        };
      };

      const cards = json?.data?.cards;
      if (!cards || cards.length === 0) {
        throw new Error("百度热搜返回数据格式异常：无 cards");
      }

      const items: RawHotItem[] = [];

      for (const card of cards) {
        if (!card.content) continue;

        for (const item of card.content) {
          if (!item.word) continue;

          items.push({
            keyword: item.word.trim(),
            heatScore: parseInt(item.hotScore || "0", 10),
            platform: "baidu",
            rank: item.index,
            url: item.url,
            description: item.desc,
            crawledAt: now,
          });
        }
      }

      // 按热度排序，取前100
      items.sort((a, b) => b.heatScore - a.heatScore);
      const top100 = items.slice(0, 100);

      logger.info(
        { platform: "baidu", count: top100.length },
        "百度热搜抓取完成"
      );

      return {
        platform: "baidu",
        items: top100,
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "baidu", error: errorMsg }, "百度热搜抓取失败");

      return {
        platform: "baidu",
        items: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }
}
