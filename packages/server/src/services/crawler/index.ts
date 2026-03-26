/**
 * Agent 1：热点爬虫调度器
 *
 * 统一调度所有平台爬虫，汇总结果
 * 支持按需单平台抓取或全平台批量抓取
 */

import { logger } from "../../config/logger.js";
import { BaiduCrawler } from "./baidu-crawler.js";
import { WeiboCrawler } from "./weibo-crawler.js";
import { ZhihuCrawler } from "./zhihu-crawler.js";
import { ToutiaoCrawler } from "./toutiao-crawler.js";
import { OpenAlexCrawler } from "./openalex-crawler.js";
import { PubMedCrawler } from "./pubmed-crawler.js";
import { ArxivCrawler } from "./arxiv-crawler.js";
import type { CrawlerAdapter, CrawlerResult, PlatformName } from "./types.js";

// 注册所有爬虫适配器
const crawlerRegistry = new Map<PlatformName, CrawlerAdapter>();
// 社交媒体（行业定向搜索版）
crawlerRegistry.set("baidu", new BaiduCrawler());
crawlerRegistry.set("weibo", new WeiboCrawler());
crawlerRegistry.set("zhihu", new ZhihuCrawler());
crawlerRegistry.set("toutiao", new ToutiaoCrawler());
// 学术数据源
crawlerRegistry.set("openalex", new OpenAlexCrawler());
crawlerRegistry.set("pubmed", new PubMedCrawler());
crawlerRegistry.set("arxiv", new ArxivCrawler());

/**
 * 获取所有已注册平台
 */
export function getRegisteredPlatforms(): PlatformName[] {
  return Array.from(crawlerRegistry.keys());
}

/**
 * 抓取单个平台
 */
export async function crawlPlatform(
  platform: PlatformName
): Promise<CrawlerResult> {
  const crawler = crawlerRegistry.get(platform);
  if (!crawler) {
    return {
      platform,
      items: [],
      success: false,
      error: `未注册的平台: ${platform}`,
      crawledAt: new Date().toISOString(),
    };
  }
  return crawler.crawl();
}

/**
 * 批量抓取所有平台（并发执行）
 */
export async function crawlAll(): Promise<CrawlerResult[]> {
  const platforms = getRegisteredPlatforms();
  logger.info(
    { platforms, count: platforms.length },
    "🕷️ Agent 1 启动：开始批量抓取所有平台热点"
  );

  const startTime = Date.now();

  // 所有平台并发执行
  const results = await Promise.allSettled(
    platforms.map((p) => crawlPlatform(p))
  );

  const crawlerResults: CrawlerResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      platform: platforms[i],
      items: [],
      success: false,
      error: r.reason?.message || "Unknown error",
      crawledAt: new Date().toISOString(),
    };
  });

  const totalItems = crawlerResults.reduce(
    (sum, r) => sum + r.items.length,
    0
  );
  const successCount = crawlerResults.filter((r) => r.success).length;

  logger.info(
    {
      totalItems,
      successPlatforms: successCount,
      totalPlatforms: platforms.length,
      durationMs: Date.now() - startTime,
    },
    "🕷️ Agent 1 完成：热点抓取结束"
  );

  return crawlerResults;
}

export type { CrawlerResult, RawHotItem, PlatformName } from "./types.js";
