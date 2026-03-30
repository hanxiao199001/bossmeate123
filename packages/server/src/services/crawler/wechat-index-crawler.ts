/**
 * 微信指数热词爬虫 —— 国内核心线
 *
 * 注意：微信指数API需要微信登录态，服务器端无法直接调用。
 * 替代策略：
 * 1. 用搜狗微信搜索获取公众号热文标题（搜狗是微信内容唯一外部搜索入口）
 * 2. 从热文标题中提取学术领域的热门话题
 * 3. 后续可接入微信指数小程序的数据（手动录入或OCR）
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, HotKeywordItem } from "./types.js";
import { DOMESTIC_HOT_DISCIPLINES } from "./types.js";

// 搜狗微信搜索的学科种子词
const WECHAT_SEARCH_SEEDS: Record<string, string[]> = {
  education: ["核心期刊推荐 教育", "CSSCI 教育投稿", "教育评职称"],
  economics: ["经济核心期刊", "SSCI 经济投稿", "管理学报"],
  medicine: ["SCI 医学投稿", "中华医学杂志", "医学核心期刊"],
  agriculture: ["农业核心期刊", "农林科学投稿"],
  engineering: ["工程核心期刊", "EI 投稿经验"],
  environment: ["环境科学核心", "环境工程投稿"],
  law: ["法学核心期刊", "法律论文发表"],
  psychology: ["心理学报", "心理学核心期刊"],
};

export class WechatIndexCrawler implements CrawlerAdapter {
  platform = "wechat-index" as const;
  track = "domestic" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const keywords: HotKeywordItem[] = [];

      for (const discipline of DOMESTIC_HOT_DISCIPLINES) {
        const seeds = WECHAT_SEARCH_SEEDS[discipline.code] || [];

        for (const seed of seeds) {
          try {
            const items = await this.searchSogouWeixin(seed, discipline.label);
            keywords.push(...items.map((item) => ({ ...item, crawledAt: now })));
            await new Promise((r) => setTimeout(r, 800)); // 搜狗限频较严
          } catch {
            // 单个失败不影响整体
          }
        }
      }

      // 去重
      const seen = new Set<string>();
      const unique = keywords.filter((item) => {
        const key = item.keyword.toLowerCase().replace(/\s+/g, "").slice(0, 30);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.heatScore - a.heatScore);

      logger.info(
        { platform: "wechat-index", count: unique.length },
        "搜狗微信热文关键词抓取完成"
      );

      return {
        platform: "wechat-index",
        track: "domestic",
        keywords: unique,
        journals: [],
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "搜狗微信热文抓取失败");
      return {
        platform: "wechat-index",
        track: "domestic",
        keywords: [],
        journals: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }

  /**
   * 搜狗微信搜索（公开接口，不需要登录）
   * 提取公众号文章标题作为热词来源
   */
  private async searchSogouWeixin(
    query: string,
    discipline: string
  ): Promise<Omit<HotKeywordItem, "crawledAt">[]> {
    const url = `https://weixin.sogou.com/weixin?type=2&s_from=input&query=${encodeURIComponent(query)}&ie=utf8&_sug_=n&_sug_type_=`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
        Referer: "https://weixin.sogou.com/",
      },
    });

    if (!response.ok) return [];

    const html = await response.text();

    // 提取文章标题（搜狗微信搜索结果页的标题格式）
    const results: Omit<HotKeywordItem, "crawledAt">[] = [];

    // 匹配搜索结果标题
    const titlePatterns = [
      /<a[^>]*href="[^"]*weixin[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
      /class="txt-box"[\s\S]*?<h3>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi,
    ];

    for (const pattern of titlePatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null && results.length < 8) {
        const title = match[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&[a-z]+;/gi, "")
          .replace(/\s+/g, " ")
          .trim();

        if (title.length >= 8 && title.length <= 80) {
          results.push({
            keyword: title,
            heatScore: 200 - results.length * 20,
            trend: "stable",
            discipline,
            platform: "wechat-index",
            rank: results.length + 1,
            description: `公众号热文 | 搜索: ${query}`,
          });
        }
      }
    }

    // 保底：如果搜狗页面结构变了匹配不到，用种子词+学科标签
    if (results.length === 0) {
      results.push({
        keyword: query,
        heatScore: 50,
        trend: "stable",
        discipline,
        platform: "wechat-index",
        rank: 1,
        description: "微信搜索种子词（保底）",
      });
    }

    return results;
  }
}
