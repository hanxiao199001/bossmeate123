/**
 * 头条热榜爬虫
 *
 * 数据源：今日头条热榜（公开API）
 * 抓取内容：热文标题 + 热度值
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, RawHotItem } from "./types.js";

export class ToutiaoCrawler implements CrawlerAdapter {
  platform = "toutiao" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const response = await fetch(
        "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://www.toutiao.com/",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as {
        status?: string;
        data?: Array<{
          Title?: string;
          HotValue?: string;
          Url?: string;
          ClusterIdStr?: string;
        }>;
      };

      if (!json.data) {
        throw new Error("头条热榜返回数据格式异常");
      }

      const items: RawHotItem[] = json.data
        .filter((item) => item.Title)
        .map((item, idx) => ({
          keyword: item.Title!.trim(),
          heatScore: parseInt(item.HotValue || "0", 10),
          platform: "toutiao" as const,
          rank: idx + 1,
          url: item.Url,
          crawledAt: now,
        }));

      const top100 = items.slice(0, 100);

      logger.info(
        { platform: "toutiao", count: top100.length },
        "头条热榜抓取完成"
      );

      return {
        platform: "toutiao",
        items: top100,
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { platform: "toutiao", error: errorMsg },
        "头条热榜抓取失败"
      );

      return {
        platform: "toutiao",
        items: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }
}
