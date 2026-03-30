/**
 * 百度学术热词爬虫 —— 国内核心线
 *
 * 搜索路径：
 *   https://suggestion.baidu.com/su?wd={种子词}&cb=cb
 *   → 返回 JSONP：cb({q:"...",s:["联想词1","联想词2",...]})
 *   → 每个学科 9-12 个种子词 × 5 条联想 = ~400 条原始热词
 *
 * 为什么用这个：
 *   - 百度搜索建议 API 是完全公开的，不需要任何 key 或登录
 *   - 返回的是真实用户正在搜索的联想词，代表真实需求
 *   - 从国内服务器访问速度快，不会被封
 *
 * 注意：百度返回的编码可能是 GBK，Node.js fetch 默认用 UTF-8
 *       如果乱码需要加 iconv-lite 转码
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, HotKeywordItem } from "./types.js";
import { DOMESTIC_HOT_DISCIPLINES } from "./types.js";

// 每个学科的搜索种子词（精准匹配国内核心市场需求）
const DISCIPLINE_SEEDS: Record<string, string[]> = {
  education: [
    "教育核心期刊", "教育论文发表", "教育研究选题",
    "CSSCI教育", "教育评职称", "课程思政论文",
    "教育学报投稿", "高等教育研究", "教育数字化",
    "双减政策研究", "教育类普刊", "教育论文写作",
  ],
  economics: [
    "经济管理核心期刊", "经济学论文", "管理学报投稿",
    "经济研究投稿", "数字经济论文", "CSSCI经济",
    "碳中和经济", "ESG研究", "供应链管理论文",
  ],
  medicine: [
    "医学核心期刊", "中华医学杂志投稿", "医学论文发表",
    "临床医学投稿", "护理学核心", "中医药核心期刊",
    "医学评职称论文", "循证医学", "医学Meta分析",
  ],
  agriculture: [
    "农业核心期刊", "农林科学核心", "农业经济论文",
    "畜牧兽医投稿", "食品科学核心", "园艺学报投稿",
    "水产养殖论文", "土壤学报", "农业科学研究",
  ],
  engineering: [
    "工程技术核心期刊", "机械工程学报", "土木工程论文",
    "电气工程核心", "自动化学报投稿", "EI投稿经验",
    "建筑科学投稿", "通信工程论文", "工程管理论文",
  ],
  environment: [
    "环境科学核心期刊", "环境保护论文发表", "环境工程学报投稿",
    "水处理技术论文", "大气污染研究", "生态学核心期刊",
  ],
  law: [
    "法学核心期刊", "法律论文发表", "法学研究投稿",
    "CSSCI法学", "知识产权论文", "刑法研究",
  ],
  psychology: [
    "心理学核心期刊", "心理学报投稿", "心理科学进展投稿",
    "应用心理学论文", "教育心理学研究", "临床心理学",
  ],
};

export class BaiduAcademicCrawler implements CrawlerAdapter {
  platform = "baidu-academic" as const;
  track = "domestic" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const keywords: HotKeywordItem[] = [];
      let successCount = 0;
      let failCount = 0;

      for (const discipline of DOMESTIC_HOT_DISCIPLINES) {
        const seeds = DISCIPLINE_SEEDS[discipline.code] || [];

        for (const seed of seeds) {
          try {
            const suggestions = await this.fetchSuggestions(seed);
            if (suggestions.length > 0) successCount++;

            for (let i = 0; i < suggestions.length; i++) {
              keywords.push({
                keyword: suggestions[i],
                heatScore: 100 - i * 10, // 联想排名越前热度越高
                trend: "stable",
                discipline: discipline.label,
                platform: "baidu-academic",
                rank: keywords.length + 1,
                description: `百度联想词 | 种子: ${seed}`,
                crawledAt: now,
              });
            }
            // 控制频率
            await sleep(200);
          } catch (err) {
            failCount++;
            logger.debug({ seed, error: String(err) }, "百度建议API单次请求失败");
          }
        }
      }

      // 去重
      const seen = new Set<string>();
      const unique = keywords.filter((item) => {
        const key = item.keyword.toLowerCase().replace(/\s+/g, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.heatScore - a.heatScore);

      logger.info(
        { platform: "baidu-academic", total: unique.length, successSeeds: successCount, failSeeds: failCount },
        "百度学术热词抓取完成"
      );

      return {
        platform: "baidu-academic",
        track: "domestic",
        keywords: unique,
        journals: [],
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "百度学术热词抓取失败");
      return {
        platform: "baidu-academic",
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
   * 百度搜索建议API
   *
   * 请求: https://suggestion.baidu.com/su?wd=教育核心期刊&cb=cb
   * 响应: cb({q:"教育核心期刊",p:false,s:["教育核心期刊目录","教育核心期刊排名",...]})
   *
   * 注意：响应可能是 GBK 编码，需要用 arrayBuffer + TextDecoder 处理
   */
  private async fetchSuggestions(query: string): Promise<string[]> {
    const url = `https://suggestion.baidu.com/su?wd=${encodeURIComponent(query)}&cb=cb&ie=utf-8&t=${Date.now()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://www.baidu.com/",
        },
        signal: controller.signal,
      });

      if (!response.ok) return [];

      // 已通过 ie=utf-8 参数强制百度返回 UTF-8 编码
      const buffer = await response.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

      // 解析 JSONP: cb({q:"...",p:false,s:["a","b","c"]})
      const match = text.match(/\[([^\]]*)\]/);
      if (!match) return [];

      const suggestions: string[] = JSON.parse(`[${match[1]}]`);
      return suggestions
        .filter((s) => s.length >= 4 && s.length <= 50)
        .slice(0, 5);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
