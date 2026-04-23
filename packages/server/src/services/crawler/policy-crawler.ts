/**
 * 职称政策监控爬虫 —— 国内核心线
 *
 * 数据源：各省市人社厅/教育厅官网公告
 * 目的：监控职称评审政策变动，生成高流量内容素材
 *
 * 员工录音洞察："结合一些关于教育领域或品质领域的最新政策变动内容"
 * "各地区评职称政策不一样，有些人不知道怎么改动"—— 信息差就是流量
 *
 * 策略：用百度搜索建议+资讯获取最新政策关键词
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, HotKeywordItem } from "./types.js";

// 政策监控种子词
const POLICY_SEEDS = [
  // 职称评审政策
  "职称评审 2026", "职称评审 最新政策", "职称评审 论文要求",
  "副高职称 评审条件", "正高职称 论文", "中级职称 核心期刊",
  "医生职称 评审", "教师职称 论文", "工程师职称 评审",
  // 学位政策
  "硕士毕业 论文要求", "博士毕业 发表要求", "研究生 学位论文",
  "学位授权点 评估", "双一流 学科评估",
  // 基金政策
  "国家自然科学基金 2026", "社科基金 申报", "省级课题 申报",
  // 期刊政策
  "中科院预警名单 2026", "北大核心 目录更新", "CSSCI 来源期刊",
  "期刊评价 最新", "学术不端 处罚", "论文查重 新规",
];

export class PolicyCrawler implements CrawlerAdapter {
  platform = "policy-monitor" as const;
  track = "domestic" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const keywords: HotKeywordItem[] = [];

      for (const seed of POLICY_SEEDS) {
        try {
          // 用百度搜索建议获取政策相关的联想词
          const suggestions = await this.fetchSuggestions(seed);
          for (const s of suggestions) {
            keywords.push({
              keyword: s,
              heatScore: 150 - keywords.length % 30,
              trend: "rising", // 政策类内容通常是上升趋势
              discipline: this.detectDiscipline(s),
              platform: "policy-monitor",
              rank: keywords.length + 1,
              description: `政策热词 | 种子: ${seed}`,
              crawledAt: now,
            });
          }
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          // 单个失败不影响整体
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
        { platform: "policy-monitor", count: unique.length },
        "职称政策热词抓取完成"
      );

      return {
        platform: "policy-monitor",
        track: "domestic",
        keywords: unique,
        journals: [],
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "职称政策热词抓取失败");
      return {
        platform: "policy-monitor",
        track: "domestic",
        keywords: [],
        journals: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }

  private async fetchSuggestions(query: string): Promise<string[]> {
    const url = `https://suggestion.baidu.com/su?wd=${encodeURIComponent(query)}&cb=cb&t=${Date.now()}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.baidu.com/",
      },
    });

    if (!response.ok) return [];

    const text = await response.text();
    const match = text.match(/\[([^\]]*)\]/);
    if (!match) return [];

    try {
      const suggestions: string[] = JSON.parse(`[${match[1]}]`);
      return suggestions
        .filter((s) => typeof s === "string")
        .map((s) => s.replace(/\x00/g, "").trim())
        .filter((s) => {
          if (s.length < 4 || s.length > 50) return false;
          // 过滤乱码：包含空字节或大量不可识别字符则丢弃
          const nullCount = (s.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
          return nullCount === 0;
        })
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  /** 根据关键词内容判断所属学科 */
  private detectDiscipline(keyword: string): string {
    const lower = keyword.toLowerCase();
    if (/医|护理|临床|药学|公共卫生/.test(lower)) return "医学";
    if (/教育|教师|教学|课程|高校/.test(lower)) return "教育";
    if (/经济|管理|金融|财经|商业/.test(lower)) return "经济管理";
    if (/工程|机械|土木|电气|建筑/.test(lower)) return "工程技术";
    if (/农|林|牧|渔|食品/.test(lower)) return "农林";
    if (/环境|生态|能源/.test(lower)) return "环境科学";
    if (/法学|法律|法治/.test(lower)) return "法学";
    if (/心理/.test(lower)) return "心理学";
    return "综合"; // 跨学科的政策类
  }
}
