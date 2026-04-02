/**
 * T310: AI 质检评分引擎 v1
 *
 * 5 维度评分体系：
 * 1. 原创度 (0-20)     — 内容独特性，非搬运/洗稿
 * 2. 学术规范 (0-20)   — 术语准确、引用规范、数据可靠
 * 3. SEO 友好度 (0-20) — 关键词密度、标题吸引力、结构清晰
 * 4. 可读性 (0-20)     — 通顺流畅、排版合理、受众匹配
 * 5. 行业度 (0-20)     — 领域相关性、专业深度、实用价值
 *
 * 总分 100 分，70 分以上通过
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { eq, and, inArray } from "drizzle-orm";

// ============ 类型定义 ============

export interface QualityDimension {
  name: string;
  score: number;         // 0-20
  maxScore: 20;
  feedback: string;      // 评分说明
  suggestions: string[]; // 改进建议
}

export interface QualityReport {
  contentId: string;
  title: string;
  totalScore: number;    // 0-100
  grade: "A" | "B" | "C" | "D" | "F";
  passed: boolean;       // >= 70
  dimensions: {
    originality: QualityDimension;
    academicRigor: QualityDimension;
    seoFriendliness: QualityDimension;
    readability: QualityDimension;
    industryRelevance: QualityDimension;
  };
  overallFeedback: string;
  topIssues: string[];
}

// ============ 核心逻辑 ============

/**
 * 单篇内容质检
 */
export async function checkContentQuality(
  contentId: string,
  tenantId: string
): Promise<QualityReport | null> {
  const [content] = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, contentId), eq(contents.tenantId, tenantId)))
    .limit(1);

  if (!content || !content.body) {
    logger.warn({ contentId }, "内容不存在或正文为空");
    return null;
  }

  return evaluateContent(contentId, content.title || "无标题", content.body, tenantId);
}

/**
 * 批量质检（调度器入口）
 */
export async function batchQualityCheck(
  tenantId: string
): Promise<{ checked: number; passed: number; avgScore: number }> {
  logger.info({ tenantId }, "🔍 开始批量内容质检");

  // 获取最近的 draft/reviewing 状态内容
  const pendingContents = await db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.tenantId, tenantId),
        inArray(contents.status, ["draft", "reviewing"])
      )
    )
    .limit(10);

  if (pendingContents.length === 0) {
    return { checked: 0, passed: 0, avgScore: 0 };
  }

  let totalScore = 0;
  let passedCount = 0;

  for (const content of pendingContents) {
    if (!content.body || content.body.length < 50) continue;

    try {
      const report = await evaluateContent(
        content.id,
        content.title || "无标题",
        content.body,
        tenantId
      );

      if (!report) continue;

      totalScore += report.totalScore;
      if (report.passed) passedCount++;

      // 更新内容 metadata 中的质检结果
      const existingMeta = (content.metadata as Record<string, unknown>) || {};
      await db
        .update(contents)
        .set({
          metadata: {
            ...existingMeta,
            qualityScore: report.totalScore,
            qualityGrade: report.grade,
            qualityCheckedAt: new Date().toISOString(),
            topIssues: report.topIssues,
          },
          status: report.passed ? "reviewing" : "draft",
          updatedAt: new Date(),
        })
        .where(eq(contents.id, content.id));
    } catch (err) {
      logger.warn({ err, contentId: content.id }, "单篇质检失败");
    }
  }

  const avgScore = pendingContents.length > 0
    ? Math.round(totalScore / pendingContents.length)
    : 0;

  logger.info(
    { checked: pendingContents.length, passed: passedCount, avgScore },
    "🔍 批量质检完成"
  );

  return { checked: pendingContents.length, passed: passedCount, avgScore };
}

/**
 * AI 评估内容质量
 */
async function evaluateContent(
  contentId: string,
  title: string,
  body: string,
  tenantId: string
): Promise<QualityReport | null> {
  const bodyPreview = body.slice(0, 3000);
  const wordCount = body.length;

  const prompt = `你是一个专业的内容质检专家，专注于学术自媒体领域。

请对以下内容进行 5 维度评分（每个维度 0-20 分，总分 100 分）。

标题: ${title}
字数: ${wordCount}
正文:
${bodyPreview}

直接输出 JSON（不要其他文字）:
{
  "originality": {
    "score": 0,
    "feedback": "评分说明",
    "suggestions": ["建议1"]
  },
  "academicRigor": {
    "score": 0,
    "feedback": "评分说明",
    "suggestions": ["建议1"]
  },
  "seoFriendliness": {
    "score": 0,
    "feedback": "评分说明",
    "suggestions": ["建议1"]
  },
  "readability": {
    "score": 0,
    "feedback": "评分说明",
    "suggestions": ["建议1"]
  },
  "industryRelevance": {
    "score": 0,
    "feedback": "评分说明",
    "suggestions": ["建议1"]
  },
  "overallFeedback": "总体评价（50字）",
  "topIssues": ["最突出问题1", "最突出问题2"]
}

评分标准:
- 原创度: 独特观点、非搬运、有自己的分析
- 学术规范: 术语准确、引用规范、数据可靠、无学术不端
- SEO友好度: 标题含关键词、结构清晰有小标题、长度适中
- 可读性: 通顺流畅、段落分明、专业术语有解释
- 行业度: 领域相关性强、有专业深度、对读者有实用价值`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-check",
      message: prompt,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    const dimensions = {
      originality: buildDimension("原创度", parsed.originality),
      academicRigor: buildDimension("学术规范", parsed.academicRigor),
      seoFriendliness: buildDimension("SEO友好度", parsed.seoFriendliness),
      readability: buildDimension("可读性", parsed.readability),
      industryRelevance: buildDimension("行业度", parsed.industryRelevance),
    };

    const totalScore =
      dimensions.originality.score +
      dimensions.academicRigor.score +
      dimensions.seoFriendliness.score +
      dimensions.readability.score +
      dimensions.industryRelevance.score;

    const grade = getGrade(totalScore);

    return {
      contentId,
      title,
      totalScore,
      grade,
      passed: totalScore >= 70,
      dimensions,
      overallFeedback: parsed.overallFeedback || "",
      topIssues: parsed.topIssues || [],
    };
  } catch (err) {
    logger.error({ err, contentId }, "AI 质检评分失败");
    return null;
  }
}

function buildDimension(
  name: string,
  data: { score?: number; feedback?: string; suggestions?: string[] } | undefined
): QualityDimension {
  return {
    name,
    score: Math.min(Math.max(data?.score || 0, 0), 20),
    maxScore: 20,
    feedback: data?.feedback || "",
    suggestions: data?.suggestions || [],
  };
}

function getGrade(score: number): QualityReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}
