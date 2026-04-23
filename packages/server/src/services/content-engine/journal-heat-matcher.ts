/**
 * 期刊热度交叉匹配引擎
 *
 * 核心逻辑：把第二层（热度信号）和第一层（期刊基础库）做交叉匹配
 * 输出：每个热度信号绑定 1-5 本具体期刊，含期刊的投稿指标
 *
 * 匹配策略：
 * 1. 关键词 → 学科 → 该学科下的期刊列表
 * 2. 期刊名直接命中（热度信号中直接提到了某本期刊）
 * 3. 综合排序：搜索热度 × 期刊权重（IF/录用率/审稿速度）
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals, keywords as keywordsTable } from "../../models/schema.js";
import { eq, and, desc, isNotNull, sql } from "drizzle-orm";
import type { HotKeywordItem, RawHotItem } from "../crawler/types.js";

// ============ 类型定义 ============

export interface JournalMatch {
  journalId: string;
  journalName: string;
  journalNameEn?: string | null;
  issn?: string | null;
  discipline?: string | null;
  partition?: string | null;         // Q1/Q2/Q3/Q4
  impactFactor?: number | null;
  acceptanceRate?: number | null;
  reviewCycle?: string | null;
  apcFee?: number | null;
  citeScore?: number | null;
  timeToFirstDecisionDays?: number | null;
  isOA?: boolean | null;
  catalogType?: string | null;       // sci | pku-core | cssci 等
  catalogs?: string[];               // 所属多个目录
  matchScore: number;                // 匹配分（越高越好）
  matchReason: string;               // 匹配原因
}

export interface HeatMatchResult {
  keyword: string;
  heatScore: number;
  trend: string;
  discipline: string;
  platform: string;
  matchedJournals: JournalMatch[];   // 匹配到的期刊列表（按 matchScore 降序）
  articleSuggestion?: string;        // 建议的文章标题方向
}

// ============ 学科关键词 → 学科映射 ============

const DISCIPLINE_KEYWORDS: Record<string, string[]> = {
  "教育学": ["教育", "教学", "课程", "思政", "高等教育", "职业教育", "教师", "CSSCI教育", "教育评职称"],
  "经济学": ["经济", "金融", "财务", "会计", "管理", "营销", "供应链", "ESG", "碳中和", "数字经济"],
  "管理学": ["管理", "MBA", "企业", "创新", "战略", "人力资源", "组织行为"],
  "医学": ["医学", "临床", "护理", "肿瘤", "心血管", "糖尿病", "中医", "药学", "GLP-1", "SGLT2", "免疫治疗"],
  "法学": ["法学", "法律", "法治", "司法", "知识产权", "行政法", "刑法", "民法"],
  "计算机": ["计算机", "AI", "人工智能", "机器学习", "深度学习", "大模型", "NLP", "计算机视觉"],
  "工程技术": ["工程", "机械", "电气", "自动化", "控制", "土木", "建筑"],
  "化学": ["化学", "催化", "有机化学", "材料化学", "电化学"],
  "生物学": ["生物", "基因", "蛋白质", "微生物", "肠道菌群", "细胞"],
  "材料科学": ["材料", "纳米", "聚合物", "陶瓷", "合金", "复合材料"],
  "环境科学": ["环境", "生态", "污染", "碳排放", "可持续", "气候变化"],
  "物理": ["物理", "量子", "光学", "凝聚态", "半导体"],
  "能源": ["能源", "新能源", "锂电池", "光伏", "氢能", "储能"],
  "农林科学": ["农业", "农林", "作物", "土壤", "畜牧", "水产"],
  "心理学": ["心理", "认知", "行为", "情绪", "心理健康"],
  "数学": ["数学", "统计", "概率", "优化", "算法"],
};

// ============ 核心匹配逻辑 ============

/**
 * 推断关键词所属学科
 */
function inferDiscipline(keyword: string): string[] {
  const matched: string[] = [];

  for (const [discipline, keywords] of Object.entries(DISCIPLINE_KEYWORDS)) {
    for (const kw of keywords) {
      if (keyword.includes(kw) || kw.includes(keyword)) {
        matched.push(discipline);
        break;
      }
    }
  }

  return matched.length > 0 ? matched : ["综合"];
}

/**
 * 计算期刊匹配分数
 * 综合考虑：IF、录用率、审稿速度、分区
 */
function calculateJournalScore(journal: any): number {
  let score = 0;

  // 影响因子（0-30 分）
  const IF = journal.impactFactor || 0;
  if (IF > 10) score += 30;
  else if (IF > 5) score += 25;
  else if (IF > 3) score += 20;
  else if (IF > 1) score += 15;
  else if (IF > 0) score += 10;

  // 分区（0-25 分）
  const partition = (journal.partition || "").toUpperCase();
  if (partition.includes("Q1")) score += 25;
  else if (partition.includes("Q2")) score += 20;
  else if (partition.includes("Q3")) score += 15;
  else if (partition.includes("Q4")) score += 10;

  // 录用率越高越好（客户偏好：0-20 分）
  const ar = journal.acceptanceRate || 0;
  if (ar > 0.5) score += 20;
  else if (ar > 0.3) score += 15;
  else if (ar > 0.15) score += 10;
  else if (ar > 0) score += 5;

  // 审稿速度：越快越好（0-15 分）
  const tfd = journal.timeToFirstDecisionDays || 0;
  if (tfd > 0 && tfd <= 14) score += 15;
  else if (tfd <= 30) score += 12;
  else if (tfd <= 60) score += 8;
  else if (tfd <= 90) score += 5;

  // 是否核心期刊（国内，+10 分）
  const catalogs = journal.catalogs || [];
  if (catalogs.includes("cssci") || catalogs.includes("pku-core")) score += 10;
  if (catalogs.includes("cscd")) score += 8;

  // 有 CiteScore（+5 分）
  if (journal.citeScore && journal.citeScore > 0) score += 5;

  return score;
}

/**
 * 核心函数：热度信号 × 期刊库交叉匹配
 */
export async function matchHeatWithJournals(
  tenantId: string,
  hotKeywords: HotKeywordItem[],
  options?: {
    maxJournalsPerKeyword?: number;
    minMatchScore?: number;
  }
): Promise<HeatMatchResult[]> {
  const { maxJournalsPerKeyword = 5, minMatchScore = 10 } = options || {};

  const results: HeatMatchResult[] = [];

  // 预加载租户的所有期刊
  const allJournals = await db
    .select()
    .from(journals)
    .where(eq(journals.tenantId, tenantId));

  logger.info(
    { tenantId, totalJournals: allJournals.length, totalKeywords: hotKeywords.length },
    "Starting heat-journal matching"
  );

  for (const kw of hotKeywords) {
    // Step 1: 推断学科
    const disciplines = kw.discipline
      ? [kw.discipline]
      : inferDiscipline(kw.keyword);

    // Step 2: 在期刊库中查找匹配
    const matchedJournals: JournalMatch[] = [];

    for (const journal of allJournals) {
      let matchScore = 0;
      let matchReason = "";

      // 匹配方式 1：期刊名直接命中
      const journalName = (journal.name || "").toLowerCase();
      const journalNameEn = (journal.nameEn || "").toLowerCase();
      const kwLower = kw.keyword.toLowerCase();

      if (journalName.includes(kwLower) || kwLower.includes(journalName)) {
        matchScore += 50;
        matchReason = "期刊名直接命中";
      } else if (journalNameEn && (journalNameEn.includes(kwLower) || kwLower.includes(journalNameEn))) {
        matchScore += 50;
        matchReason = "英文名直接命中";
      }

      // 匹配方式 2：学科匹配
      if (journal.discipline && disciplines.includes(journal.discipline)) {
        matchScore += 30;
        matchReason = matchReason || `学科匹配: ${journal.discipline}`;
      }

      // 如果没有任何匹配，跳过
      if (matchScore === 0) continue;

      // Step 3: 叠加期刊自身质量分
      matchScore += calculateJournalScore(journal);

      if (matchScore < minMatchScore) continue;

      matchedJournals.push({
        journalId: journal.id,
        journalName: journal.name,
        journalNameEn: journal.nameEn,
        issn: journal.issn,
        discipline: journal.discipline,
        partition: journal.partition,
        impactFactor: journal.impactFactor,
        acceptanceRate: journal.acceptanceRate,
        reviewCycle: journal.reviewCycle,
        apcFee: journal.apcFee,
        citeScore: journal.citeScore,
        timeToFirstDecisionDays: journal.timeToFirstDecisionDays,
        isOA: journal.isOA,
        catalogType: journal.catalogType,
        catalogs: (journal.catalogs as string[]) || [],
        matchScore,
        matchReason,
      });
    }

    // Step 4: 按 matchScore 降序排列，取 top N
    matchedJournals.sort((a, b) => b.matchScore - a.matchScore);
    const topJournals = matchedJournals.slice(0, maxJournalsPerKeyword);

    if (topJournals.length > 0) {
      results.push({
        keyword: kw.keyword,
        heatScore: kw.heatScore,
        trend: kw.trend,
        discipline: disciplines[0] || "综合",
        platform: kw.platform,
        matchedJournals: topJournals,
        articleSuggestion: generateArticleSuggestion(kw, topJournals),
      });
    }
  }

  // 按热度降序排列
  results.sort((a, b) => b.heatScore - a.heatScore);

  logger.info(
    {
      totalResults: results.length,
      withJournals: results.filter(r => r.matchedJournals.length > 0).length,
    },
    "Heat-journal matching completed"
  );

  return results;
}

/**
 * 根据热度信号和匹配期刊生成文章标题建议
 */
function generateArticleSuggestion(
  keyword: HotKeywordItem,
  journals: JournalMatch[]
): string {
  const topJournal = journals[0];

  if (!topJournal) return "";

  // 根据不同类型生成不同方向
  const journalCount = journals.length;

  if (keyword.trend === "rising" || keyword.trend === "stable") {
    if (journalCount >= 3) {
      return `${keyword.keyword}方向 ${journalCount} 本推荐期刊对比：录用率、审稿周期、版面费全解析`;
    }
    return `${topJournal.journalName} 最新投稿指南：影响因子 ${topJournal.impactFactor || "N/A"}，${topJournal.reviewCycle || "审稿中"}`;
  }

  return `${keyword.keyword} 领域期刊推荐：${topJournal.journalName}`;
}

/**
 * 便捷接口：获取今日热度 × 期刊匹配结果
 * 供 topic-recommender 调用
 */
export async function getTodayHeatMatches(
  tenantId: string,
  limit: number = 10
): Promise<HeatMatchResult[]> {
  // 从 keywords 表获取最近的热度信号
  const recentKeywords = await db
    .select()
    .from(keywordsTable)
    .where(
      and(
        eq(keywordsTable.tenantId, tenantId),
        eq(keywordsTable.status, "active")
      )
    )
    .orderBy(desc(keywordsTable.heatScore))
    .limit(50);

  // 转为 HotKeywordItem 格式
  const hotKeywords: HotKeywordItem[] = recentKeywords.map((k) => ({
    keyword: k.keyword,
    heatScore: k.heatScore || 0,
    trend: "stable" as const, // keywords 表无 trend 字段，默认 stable
    discipline: k.category || "综合",
    platform: (k.sourcePlatform as any) || "manual",
    crawledAt: k.createdAt?.toISOString() || new Date().toISOString(),
  }));

  const matches = await matchHeatWithJournals(tenantId, hotKeywords);

  return matches.slice(0, limit);
}
