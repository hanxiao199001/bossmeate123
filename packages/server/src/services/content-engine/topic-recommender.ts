/**
 * 每日选题推荐引擎
 *
 * 数据来源：
 * 1. keyword_history 趋势数据（exploding/rising/new）
 * 2. journals 表匹配相关期刊
 * 3. AI 生成推荐理由
 *
 * 输出：每个租户的每日选题列表，存入 daily_recommendations 表
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals, dailyRecommendations } from "../../models/schema.js";
import { eq, and, desc, or, ilike } from "drizzle-orm";
import { getTrendReport, type TrendLabel } from "../agents/keyword-trend.js";
import { chat } from "../ai/chat-service.js";
import { nanoid } from "nanoid";

// ============ 类型 ============

export interface TopicRecommendation {
  id: string;
  rank: number;
  keyword: string;
  trend: "exploding" | "rising" | "new" | "stable";
  trendScore: number;
  heatChange: string;
  relatedJournals: Array<{
    name: string;
    impactFactor: number | null;
    partition: string | null;
  }>;
  latestResearch?: {
    title: string;
    journal: string;
    pmid: string;
  };
  reason: string;
  createParams: {
    topic: string;
    keywords: string[];
    suggestedTitle: string;
    suggestedAudience: string;
    suggestedWordCount: number;
  };
}

export interface DailyRecommendationReport {
  date: string;
  tenantId: string;
  recommendations: TopicRecommendation[];
  generatedAt: string;
}

// ============ 核心 ============

export async function generateDailyRecommendations(
  tenantId: string
): Promise<DailyRecommendationReport> {
  const today = new Date().toISOString().slice(0, 10);
  logger.info({ tenantId, date: today }, "开始生成每日选题推荐");

  // 检查今天是否已生成
  const existing = await db
    .select()
    .from(dailyRecommendations)
    .where(
      and(
        eq(dailyRecommendations.tenantId, tenantId),
        eq(dailyRecommendations.date, today)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return {
      date: today,
      tenantId,
      recommendations: existing[0].recommendations as TopicRecommendation[],
      generatedAt: existing[0].generatedAt?.toISOString() || new Date().toISOString(),
    };
  }

  // Step 1: 获取趋势数据
  const trendReport = await getTrendReport(tenantId);

  const hotTopics = [
    ...trendReport.exploding.map((t) => ({ ...t, priority: 3 })),
    ...trendReport.rising.map((t) => ({ ...t, priority: 2 })),
    ...trendReport.newKeywords.map((t) => ({ ...t, priority: 1 })),
  ]
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.currentScore - a.currentScore;
    })
    .slice(0, 10);

  if (hotTopics.length === 0) {
    // 没有趋势数据，返回空推荐
    const emptyReport: DailyRecommendationReport = {
      date: today,
      tenantId,
      recommendations: [],
      generatedAt: new Date().toISOString(),
    };

    await db.insert(dailyRecommendations).values({
      tenantId,
      date: today,
      recommendations: [],
    });

    return emptyReport;
  }

  // Step 2: 为每个热词匹配期刊
  const recommendations: TopicRecommendation[] = [];

  for (let i = 0; i < hotTopics.length; i++) {
    const topic = hotTopics[i];
    const discipline = extractDiscipline(topic.keyword);

    const matchedJournals = await db
      .select()
      .from(journals)
      .where(
        and(
          eq(journals.tenantId, tenantId),
          or(
            ilike(journals.discipline, `%${discipline}%`),
            ilike(journals.name, `%${topic.keyword}%`)
          )
        )
      )
      .orderBy(desc(journals.impactFactor))
      .limit(3);

    const heatChange =
      topic.score7d > 0
        ? `↑${Math.round(topic.score7d)}%`
        : topic.score7d < 0
          ? `↓${Math.abs(Math.round(topic.score7d))}%`
          : "→";

    recommendations.push({
      id: nanoid(12),
      rank: i + 1,
      keyword: topic.keyword,
      trend: topic.trend as TopicRecommendation["trend"],
      trendScore: topic.currentScore,
      heatChange,
      relatedJournals: matchedJournals.map((j) => ({
        name: j.name,
        impactFactor: j.impactFactor,
        partition: j.partition,
      })),
      reason: "", // 后面 AI 填充
      createParams: {
        topic: topic.keyword,
        keywords: [topic.keyword, ...(topic.platforms || [])],
        suggestedTitle: `${topic.keyword}：最新研究进展与临床应用`,
        suggestedAudience: "医学从业者及科研工作者",
        suggestedWordCount: 1200,
      },
    });
  }

  // Step 3: AI 批量生成推荐理由
  try {
    const reasonPrompt = recommendations
      .map(
        (r, i) =>
          `${i + 1}. "${r.keyword}"（趋势：${r.trend}，7天变化：${r.heatChange}），相关期刊：${r.relatedJournals.map((j) => j.name).join("、") || "无"}`
      )
      .join("\n");

    const aiResult = await chat({
      tenantId,
      userId: "system",
      conversationId: "topic-recommend",
      message: `你是学术期刊选题顾问。为以下每个关键词生成一句话推荐理由（20字以内），说明为什么今天值得写这个主题。\n\n${reasonPrompt}\n\n每行输出格式：序号|理由`,
      skillType: "daily_chat",
    });

    const lines = aiResult.content.split("\n").filter((l) => l.includes("|"));
    for (const line of lines) {
      const parts = line.split("|");
      const idx = parseInt(parts[0]) - 1;
      if (idx >= 0 && idx < recommendations.length && parts[1]) {
        recommendations[idx].reason = parts[1].trim();
      }
    }
  } catch (err) {
    logger.warn({ err }, "AI 推荐理由生成失败");
  }

  // 没有 AI 理由的用默认值
  for (const rec of recommendations) {
    if (!rec.reason) {
      rec.reason =
        rec.trend === "exploding"
          ? "热度暴涨，抓紧追热点"
          : rec.trend === "rising"
            ? "持续升温，值得关注"
            : "新出现话题，抢先布局";
    }
  }

  // Step 4: 存入数据库
  await db.insert(dailyRecommendations).values({
    tenantId,
    date: today,
    recommendations: recommendations as any,
  });

  const report: DailyRecommendationReport = {
    date: today,
    tenantId,
    recommendations,
    generatedAt: new Date().toISOString(),
  };

  logger.info(
    { tenantId, date: today, count: recommendations.length },
    "每日选题推荐生成完成"
  );

  return report;
}

/**
 * 获取今日推荐（如果还没生成则自动生成）
 */
export async function getTodayRecommendations(
  tenantId: string
): Promise<DailyRecommendationReport> {
  return generateDailyRecommendations(tenantId);
}

/**
 * 获取历史推荐
 */
export async function getRecommendationHistory(
  tenantId: string,
  days: number = 7
): Promise<DailyRecommendationReport[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select()
    .from(dailyRecommendations)
    .where(eq(dailyRecommendations.tenantId, tenantId))
    .orderBy(desc(dailyRecommendations.date))
    .limit(days);

  return rows.map((r) => ({
    date: r.date,
    tenantId: r.tenantId,
    recommendations: r.recommendations as TopicRecommendation[],
    generatedAt: r.generatedAt?.toISOString() || "",
  }));
}

// ============ 工具 ============

function extractDiscipline(keyword: string): string {
  const disciplineMap: Record<string, string> = {
    "糖尿": "医学", "高血压": "医学", "肿瘤": "医学", "癌": "医学",
    "心血管": "医学", "神经": "医学", "免疫": "医学", "药": "医学",
    "教育": "教育", "教学": "教育", "课程": "教育", "学生": "教育",
    "AI": "计算机", "机器学习": "计算机", "深度学习": "计算机",
    "环境": "环境科学", "污染": "环境科学", "碳": "环境科学",
    "材料": "材料科学", "纳米": "材料科学",
    "经济": "经济管理", "管理": "经济管理", "金融": "经济管理",
    "农": "农林科学", "作物": "农林科学", "土壤": "农林科学",
    "能源": "能源", "电池": "能源", "光伏": "能源",
  };

  for (const [key, discipline] of Object.entries(disciplineMap)) {
    if (keyword.includes(key)) return discipline;
  }
  return keyword;
}
