/**
 * 微博热搜爬虫
 *
 * 数据源：微博热搜榜（公开API）
 * 抓取内容：热搜关键词 + 热度值 + 排名
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

export class WeiboCrawler implements CrawlerAdapter {
  platform = "weibo" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      // 微博热搜 API
      const response = await fetch(
        "https://weibo.com/ajax/side/hotSearch",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://weibo.com/",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as {
        ok?: number;
        data?: {
          realtime?: Array<{
            word?: string;
            num?: number;
            rank?: number;
            label_name?: string;
            note?: string;
          }>;
        };
      };

      if (json.ok !== 1 || !json.data?.realtime) {
        throw new Error("微博热搜返回数据格式异常");
      }

      const items: RawHotItem[] = json.data.realtime
        .filter((item) => item.word)
        .map((item, idx) => ({
          keyword: item.word!.trim(),
          heatScore: item.num || 0,
          platform: "weibo" as const,
          rank: item.rank ?? idx + 1,
          description: item.note || item.label_name,
          crawledAt: now,
        }));

      // 取前100
      const top100 = items.slice(0, 100);

      logger.info(
        { platform: "weibo", count: top100.length },
        "微博热搜抓取完成"
      );

      return {
        platform: "weibo",
        items: top100,
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ platform: "weibo", error: errorMsg }, "微博热搜抓取失败");

      return {
        platform: "weibo",
        items: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }
}
