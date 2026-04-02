/**
 * T301 + T302: 竞品账号管理增强 + 竞品内容 AI 深度拆解
 *
 * T301: 标签体系 + 自动分析 + 合作账号支持（Sub-lib 4 增强）
 * T302: AI 拆解竞品内容 → 入库 Sub-lib 5（竞品内容库）/ Sub-lib 6（内容拆解库）
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { db } from "../../models/db.js";
import { competitors } from "../../models/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { ingestToKnowledge } from "./ingest-pipeline.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ T301: 竞品账号管理增强 ============

export interface CompetitorAccount {
  accountId: string;
  accountName: string;
  platform: string;
  tags: string[];              // 标签体系
  type: "competitor" | "collaborator" | "benchmark";  // 竞品/合作/对标
  industry: string;
  followerCount?: number;
  contentFrequency?: string;   // 日更/周更/月更
  strengthAreas: string[];     // 优势领域
  lastAnalyzedAt?: string;
}

export interface AccountAnalysis {
  accountName: string;
  platform: string;
  contentCount: number;
  topContentTypes: Array<{ type: string; count: number }>;
  avgMetrics: { views: number; likes: number; comments: number };
  publishPattern: string;       // 发布规律描述
  styleProfile: string;         // 风格画像（一段话）
  strengthTags: string[];       // 优势标签
  weaknessTags: string[];       // 弱势标签
  opportunities: string[];      // 可借鉴的机会
}

/**
 * 分析竞品账号（基于已采集的内容数据）
 */
export async function analyzeCompetitorAccount(
  tenantId: string,
  accountId: string
): Promise<AccountAnalysis | null> {
  const articles = await db
    .select()
    .from(competitors)
    .where(
      and(
        eq(competitors.tenantId, tenantId),
        eq(competitors.accountId, accountId)
      )
    )
    .orderBy(desc(competitors.crawlDate))
    .limit(50);

  if (articles.length === 0) return null;

  const accountName = articles[0].accountName || accountId;
  const platform = articles[0].platform;

  // 统计内容类型分布
  const typeCount = new Map<string, number>();
  for (const a of articles) {
    const t = a.contentType || "unknown";
    typeCount.set(t, (typeCount.get(t) || 0) + 1);
  }
  const topContentTypes = Array.from(typeCount.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  // 统计平均数据
  let totalViews = 0, totalLikes = 0, totalComments = 0, metricsCount = 0;
  for (const a of articles) {
    const m = a.publicMetrics as Record<string, number> | null;
    if (m) {
      totalViews += m.views || 0;
      totalLikes += m.likes || 0;
      totalComments += m.comments || 0;
      metricsCount++;
    }
  }

  const avgMetrics = metricsCount > 0
    ? {
        views: Math.round(totalViews / metricsCount),
        likes: Math.round(totalLikes / metricsCount),
        comments: Math.round(totalComments / metricsCount),
      }
    : { views: 0, likes: 0, comments: 0 };

  // AI 分析风格画像
  const sampleTitles = articles
    .slice(0, 15)
    .map((a) => a.articleTitle)
    .filter(Boolean)
    .join("\n");

  const sampleHooks = articles
    .slice(0, 10)
    .flatMap((a) => (a.hookWords as string[]) || [])
    .filter(Boolean)
    .slice(0, 20);

  let styleProfile = "";
  let strengthTags: string[] = [];
  let weaknessTags: string[] = [];
  let opportunities: string[] = [];

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "competitor-analysis",
      message: `分析以下竞品账号的内容风格和策略特点。

账号: ${accountName} (${platform})
内容数量: ${articles.length}篇
内容类型分布: ${topContentTypes.map((t) => `${t.type}(${t.count})`).join(", ")}
平均数据: 阅读${avgMetrics.views} 点赞${avgMetrics.likes} 评论${avgMetrics.comments}

近期标题:
${sampleTitles}

高频噱头词: ${sampleHooks.join(", ")}

直接输出 JSON（不要其他文字）:
{
  "styleProfile": "风格画像描述（50字）",
  "strengthTags": ["优势1", "优势2", "优势3"],
  "weaknessTags": ["弱势1", "弱势2"],
  "opportunities": ["可借鉴的机会1", "可借鉴的机会2"],
  "publishPattern": "发布规律描述（20字）"
}`,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      styleProfile = parsed.styleProfile || "";
      strengthTags = parsed.strengthTags || [];
      weaknessTags = parsed.weaknessTags || [];
      opportunities = parsed.opportunities || [];
    }
  } catch (err) {
    logger.warn({ err, accountId }, "竞品AI分析失败");
  }

  return {
    accountName,
    platform,
    contentCount: articles.length,
    topContentTypes,
    avgMetrics,
    publishPattern: "待分析",
    styleProfile,
    strengthTags,
    weaknessTags,
    opportunities,
  };
}

// ============ T302: 竞品内容 AI 深度拆解 ============

export interface ContentBreakdown {
  articleTitle: string;
  structure: string;             // 文章结构（总分总/递进/对比...）
  hookAnalysis: string;          // 开头钩子分析
  emotionalTriggers: string[];   // 情绪触发词
  dataUsage: string;             // 数据使用方式
  ctaType: string;               // 行动号召类型
  contentFormula: string;        // 提炼的内容公式
  reusableParts: string[];       // 可复用的元素
}

/**
 * 批量拆解竞品内容（调度器入口）
 */
export async function analyzeCompetitorContent(
  tenantId: string
): Promise<{ analyzed: number; ingested: number }> {
  logger.info({ tenantId }, "🔍 开始竞品内容AI深度拆解");

  // 获取最近未拆解过的竞品内容
  const recentArticles = await db
    .select()
    .from(competitors)
    .where(eq(competitors.tenantId, tenantId))
    .orderBy(desc(competitors.crawlDate))
    .limit(20);

  // 过滤已拆解的（metadata 中有 analyzed 标记）
  const toAnalyze = recentArticles.filter((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    return !meta?.analyzed && a.articleContent && a.articleContent.length > 100;
  });

  if (toAnalyze.length === 0) {
    logger.info("没有需要拆解的新竞品内容");
    return { analyzed: 0, ingested: 0 };
  }

  let totalIngested = 0;

  for (const article of toAnalyze.slice(0, 5)) {
    try {
      const breakdown = await deepBreakdownArticle(article, tenantId);
      if (!breakdown) continue;

      // 入库 Sub-lib 6（内容拆解库）
      const ingestResult = await ingestToKnowledge(
        [
          {
            title: `拆解: ${article.articleTitle || "竞品文章"}`,
            content: formatBreakdown(breakdown),
            category: "content_format" as VectorCategory,
            source: `competitor:${article.accountName}:${article.platform}`,
            metadata: {
              accountName: article.accountName,
              platform: article.platform,
              originalTitle: article.articleTitle,
              structure: breakdown.structure,
              contentFormula: breakdown.contentFormula,
            },
          },
        ],
        tenantId
      );

      totalIngested += ingestResult.ingested;

      // 标记为已拆解
      await db
        .update(competitors)
        .set({
          metadata: {
            ...(article.metadata as Record<string, unknown> || {}),
            analyzed: true,
            analyzedAt: new Date().toISOString(),
          },
        })
        .where(eq(competitors.id, article.id));
    } catch (err) {
      logger.warn({ err, articleId: article.id }, "单篇竞品拆解失败");
    }
  }

  logger.info(
    { tenantId, analyzed: Math.min(toAnalyze.length, 5), ingested: totalIngested },
    "🔍 竞品内容拆解完成"
  );

  return { analyzed: Math.min(toAnalyze.length, 5), ingested: totalIngested };
}

/**
 * AI 深度拆解单篇竞品文章
 */
async function deepBreakdownArticle(
  article: {
    articleTitle: string | null;
    articleContent: string | null;
    accountName: string | null;
    platform: string;
    hookWords: unknown;
    publicMetrics: unknown;
  },
  tenantId: string
): Promise<ContentBreakdown | null> {
  const content = article.articleContent || "";
  const title = article.articleTitle || "无标题";

  // 截取前2000字用于分析
  const contentPreview = content.slice(0, 2000);

  const prompt = `你是一个爆款内容拆解专家。请深度拆解以下文章。

标题: ${title}
来源: ${article.accountName} (${article.platform})
已提取噱头词: ${JSON.stringify(article.hookWords || [])}

正文（前2000字）:
${contentPreview}

直接输出 JSON（不要其他文字）:
{
  "structure": "文章结构类型（如：问题引入→数据论证→建议→CTA）",
  "hookAnalysis": "开头钩子手法分析（30字）",
  "emotionalTriggers": ["情绪触发词1", "情绪触发词2", "情绪触发词3"],
  "dataUsage": "数据使用方式（如：权威数据开头、对比数据增强说服力）",
  "ctaType": "行动号召类型（如：关注引导/评论互动/转发收藏）",
  "contentFormula": "提炼出的内容公式（一句话描述可复用的套路）",
  "reusableParts": ["可复用元素1", "可复用元素2"]
}`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "competitor-breakdown",
      message: prompt,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      articleTitle: title,
      structure: parsed.structure || "",
      hookAnalysis: parsed.hookAnalysis || "",
      emotionalTriggers: parsed.emotionalTriggers || [],
      dataUsage: parsed.dataUsage || "",
      ctaType: parsed.ctaType || "",
      contentFormula: parsed.contentFormula || "",
      reusableParts: parsed.reusableParts || [],
    };
  } catch (err) {
    logger.error({ err, title }, "AI 文章拆解失败");
    return null;
  }
}

function formatBreakdown(bd: ContentBreakdown): string {
  return [
    `内容拆解 - 竞品文章分析`,
    `原文标题: ${bd.articleTitle}`,
    ``,
    `文章结构: ${bd.structure}`,
    `开头钩子: ${bd.hookAnalysis}`,
    `情绪触发词: ${bd.emotionalTriggers.join("、")}`,
    `数据运用: ${bd.dataUsage}`,
    `CTA类型: ${bd.ctaType}`,
    `内容公式: ${bd.contentFormula}`,
    `可复用元素: ${bd.reusableParts.join("、")}`,
  ].join("\n");
}
