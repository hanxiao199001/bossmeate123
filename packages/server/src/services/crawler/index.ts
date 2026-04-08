/**
 * 爬虫调度器
 *
 * 两条业务线：
 * 1. 国内核心线 (domestic)：抓热门学科关键词 → 做泛流量内容
 *    - baidu-academic: 百度学术热词联想
 *    - wechat-index: 搜狗微信公众号热文
 *    - policy-monitor: 职称政策热词监控
 *
 * 2. SCI线 (sci)：按LetPub大类抓期刊数据 → 匹配科研产品
 *    - letpub: LetPub期刊分类数据
 *    - openalex: OpenAlex学术数据（补充IF/发文量）
 *    - pubmed: PubMed医学方向（中国作者投稿热点）
 *    - arxiv: arXiv预印本（计算机/物理研究趋势）
 */

import { logger } from "../../config/logger.js";
import { BaiduAcademicCrawler } from "./baidu-academic-crawler.js";
import { WechatIndexCrawler } from "./wechat-index-crawler.js";
import { PolicyCrawler } from "./policy-crawler.js";
import { LetPubCrawler } from "./letpub-crawler.js";
import { OpenAlexCrawler } from "./openalex-crawler.js";
import { PubMedCrawler } from "./pubmed-crawler.js";
import { ArxivCrawler } from "./arxiv-crawler.js";
import { SpringerLinkCrawler } from "./springer-link-crawler.js";
import { BaiduCrawler } from "./baidu-crawler.js";
import { WeiboCrawler } from "./weibo-crawler.js";
import { ZhihuCrawler } from "./zhihu-crawler.js";
import { ToutiaoCrawler } from "./toutiao-crawler.js";
import type { CrawlerAdapter, CrawlerResult, CrawlerTrack, PlatformName } from "./types.js";

// ===== 注册所有爬虫 =====
const crawlerRegistry = new Map<PlatformName, CrawlerAdapter>();

// 国内核心线（热度信号）
crawlerRegistry.set("baidu-academic", new BaiduAcademicCrawler());
crawlerRegistry.set("wechat-index", new WechatIndexCrawler());
crawlerRegistry.set("policy-monitor", new PolicyCrawler());

// SCI线（期刊数据 + 热度信号）
crawlerRegistry.set("letpub", new LetPubCrawler());
crawlerRegistry.set("openalex", new OpenAlexCrawler());
crawlerRegistry.set("pubmed", new PubMedCrawler());
crawlerRegistry.set("arxiv", new ArxivCrawler());
crawlerRegistry.set("springer-link", new SpringerLinkCrawler());

// 社交热搜线（泛热度信号）
crawlerRegistry.set("baidu", new BaiduCrawler());
crawlerRegistry.set("weibo", new WeiboCrawler());
crawlerRegistry.set("zhihu", new ZhihuCrawler());
crawlerRegistry.set("toutiao", new ToutiaoCrawler());

// ===== 公开接口 =====

/** 获取所有已注册平台 */
export function getRegisteredPlatforms(): PlatformName[] {
  return Array.from(crawlerRegistry.keys());
}

/** 获取某条业务线的平台 */
export function getPlatformsByTrack(track: CrawlerTrack): PlatformName[] {
  return Array.from(crawlerRegistry.entries())
    .filter(([_, crawler]) => crawler.track === track)
    .map(([name]) => name);
}

/** 抓取单个平台 */
export async function crawlPlatform(platform: PlatformName): Promise<CrawlerResult> {
  const crawler = crawlerRegistry.get(platform);
  if (!crawler) {
    return {
      platform,
      track: "domestic",
      keywords: [],
      journals: [],
      success: false,
      error: `未注册的平台: ${platform}`,
      crawledAt: new Date().toISOString(),
    };
  }
  return crawler.crawl();
}

/** 按业务线批量抓取（并发执行） */
export async function crawlByTrack(track: CrawlerTrack): Promise<CrawlerResult[]> {
  const platforms = getPlatformsByTrack(track);
  const trackLabel = track === "domestic" ? "国内核心" : track === "social" ? "社交热搜" : "SCI";

  logger.info(
    { track, platforms, count: platforms.length },
    `🕷️ ${trackLabel}线启动：开始批量抓取`
  );

  const startTime = Date.now();

  const results = await Promise.allSettled(
    platforms.map((p) => crawlPlatform(p))
  );

  const crawlerResults: CrawlerResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      platform: platforms[i],
      track,
      keywords: [],
      journals: [],
      success: false,
      error: r.reason?.message || "Unknown error",
      crawledAt: new Date().toISOString(),
    };
  });

  const totalKeywords = crawlerResults.reduce((sum, r) => sum + r.keywords.length, 0);
  const totalJournals = crawlerResults.reduce((sum, r) => sum + r.journals.length, 0);
  const successCount = crawlerResults.filter((r) => r.success).length;

  logger.info(
    {
      track,
      totalKeywords,
      totalJournals,
      successPlatforms: successCount,
      totalPlatforms: platforms.length,
      durationMs: Date.now() - startTime,
    },
    `🕷️ ${trackLabel}线完成`
  );

  return crawlerResults;
}

/** 全部抓取（三条线并发） */
export async function crawlAll(): Promise<CrawlerResult[]> {
  logger.info("🕷️ 全量抓取启动：国内核心线 + SCI线 + 社交热搜线");
  const startTime = Date.now();

  const [domesticResults, sciResults, socialResults] = await Promise.all([
    crawlByTrack("domestic"),
    crawlByTrack("sci"),
    crawlByTrack("social"),
  ]);

  const allResults = [...domesticResults, ...sciResults, ...socialResults];

  logger.info(
    { totalPlatforms: allResults.length, durationMs: Date.now() - startTime },
    "🕷️ 全量抓取完成"
  );

  return allResults;
}

/** 导出 SpringerLinkCrawler 供月度基础库任务使用 */
export { SpringerLinkCrawler } from "./springer-link-crawler.js";

// ===== 导出类型 =====
export type { CrawlerResult, HotKeywordItem, JournalItem, PlatformName, CrawlerTrack } from "./types.js";
