/**
 * 爬虫数据 → 知识库沉淀服务
 *
 * 3 个沉淀钩子：
 * 1. sinkTrendData()    — 趋势关键词 → hot_event 子库
 * 2. sinkRecommendations() — 每日选题推荐 → insight 子库
 * 3. sinkGeneratedContent() — AI 生成文章 → domain_knowledge 子库
 *
 * 所有钩子都走 audit-pipeline 5 道审核，自动去重、质量过滤。
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { dailyRecommendations } from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import { runBatchAudit, type AuditInput } from "../knowledge/audit-pipeline.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 配置 ============

const SINK_LIMITS = {
  /** 钩子1：每日最多沉淀的趋势关键词数 */
  MAX_TREND_KEYWORDS: 10,
  /** 钩子1：7 天变化率门槛（%），只沉淀爆发/强上升的 */
  MIN_TREND_SCORE_7D: 100,
  /** 钩子2：每日最多沉淀的推荐数 */
  MAX_RECOMMENDATIONS: 5,
  /** 钩子3：最低质量分门槛 */
  MIN_QUALITY_SCORE: 70,
  /** 钩子3：文章摘要截取长度 */
  CONTENT_SUMMARY_LENGTH: 300,
};

// ============ 类型 ============

interface TrendKeyword {
  keyword: string;
  trend: string;
  score7d: number;
  currentScore: number;
  avgScore7d: number;
  platforms: string[];
  category: string | null;
  firstSeenDaysAgo: number;
  sparkline: number[];
}

interface TopicRecommendation {
  id: string;
  rank: number;
  keyword: string;
  trend: string;
  trendScore: number;
  heatChange: string;
  relatedJournals: Array<{ name: string; impactFactor: number | null; partition: string | null }>;
  reason: string;
  createParams?: {
    topic: string;
    keywords: string[];
    suggestedAudience: string;
    suggestedWordCount: number;
  };
}

interface GeneratedArticle {
  contentId: string;
  title: string;
  body: string;
  platform: string;
  qualityScore: number;
  style?: string;
  audience?: string;
  planId?: string;
}

// ============ 钩子 1：趋势关键词 → hot_event ============

/**
 * 将爆发/强上升趋势关键词沉淀到 hot_event 子库。
 * 调用时机：Orchestrator 中 analyzeKeywords + getTrendReport 之后。
 */
export async function sinkTrendData(
  trendKeywords: TrendKeyword[],
  tenantId: string,
  date: string
): Promise<{ ingested: number; rejected: number }> {
  // 筛选：只要爆发和强上升的
  const candidates = trendKeywords
    .filter((kw) => kw.score7d >= SINK_LIMITS.MIN_TREND_SCORE_7D)
    .sort((a, b) => b.score7d - a.score7d)
    .slice(0, SINK_LIMITS.MAX_TREND_KEYWORDS);

  if (candidates.length === 0) {
    logger.info({ tenantId }, "钩子1: 无符合条件的趋势关键词需沉淀");
    return { ingested: 0, rejected: 0 };
  }

  const auditInputs: AuditInput[] = candidates.map((kw) => ({
    tenantId,
    category: "hot_event" as VectorCategory,
    title: `趋势热点: ${kw.keyword}`,
    content: [
      `关键词: ${kw.keyword}`,
      `趋势: ${kw.trend}（7天变化: +${kw.score7d.toFixed(0)}%）`,
      `当前热度: ${kw.currentScore.toFixed(1)}`,
      `7天均值: ${kw.avgScore7d.toFixed(1)}`,
      `覆盖平台: ${kw.platforms.join(", ")}`,
      kw.category ? `学科领域: ${kw.category}` : "",
      `首次出现: ${kw.firstSeenDaysAgo}天前`,
      `近7天走势: ${kw.sparkline.map((v) => v.toFixed(0)).join(" → ")}`,
    ]
      .filter(Boolean)
      .join("\n"),
    source: `trend-analysis:${date}`,
    metadata: {
      trend: kw.trend,
      score7d: kw.score7d,
      currentScore: kw.currentScore,
      platforms: kw.platforms,
      discipline: kw.category,
      sinkType: "trend",
      sinkDate: date,
    },
  }));

  try {
    const { accepted, rejected } = await runBatchAudit(auditInputs);
    logger.info(
      { tenantId, total: auditInputs.length, ingested: accepted.length, rejected: rejected.length },
      "钩子1: 趋势关键词 → hot_event 沉淀完成"
    );
    return { ingested: accepted.length, rejected: rejected.length };
  } catch (err) {
    logger.error({ tenantId, err }, "钩子1: 趋势沉淀失败");
    return { ingested: 0, rejected: 0 };
  }
}

// ============ 钩子 2：每日推荐 → insight ============

/**
 * 将今日 top N 选题推荐沉淀到 insight 子库。
 * 调用时机：Orchestrator 中 generateDailyRecommendations 之后。
 */
export async function sinkRecommendations(
  tenantId: string,
  date: string
): Promise<{ ingested: number; rejected: number }> {
  // 从 daily_recommendations 表读取今日推荐
  const [rec] = await db
    .select()
    .from(dailyRecommendations)
    .where(
      and(
        eq(dailyRecommendations.tenantId, tenantId),
        eq(dailyRecommendations.date, date)
      )
    )
    .limit(1);

  if (!rec || !rec.recommendations) {
    logger.info({ tenantId }, "钩子2: 今日无推荐数据");
    return { ingested: 0, rejected: 0 };
  }

  const recommendations = (rec.recommendations as TopicRecommendation[])
    .filter((r) => r.rank <= SINK_LIMITS.MAX_RECOMMENDATIONS);

  if (recommendations.length === 0) {
    return { ingested: 0, rejected: 0 };
  }

  const auditInputs: AuditInput[] = recommendations.map((r) => ({
    tenantId,
    category: "insight" as VectorCategory,
    title: `选题推荐: ${r.keyword}`,
    content: [
      `推荐关键词: ${r.keyword}`,
      `推荐理由: ${r.reason}`,
      `趋势状态: ${r.trend}（${r.heatChange}）`,
      r.relatedJournals.length > 0
        ? `相关期刊: ${r.relatedJournals.map((j) => `${j.name}${j.impactFactor ? " IF:" + j.impactFactor : ""}${j.partition ? " " + j.partition : ""}`).join("; ")}`
        : "",
      r.createParams?.suggestedAudience
        ? `建议受众: ${r.createParams.suggestedAudience}`
        : "",
      r.createParams?.suggestedWordCount
        ? `建议字数: ${r.createParams.suggestedWordCount}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    source: `daily-recommendation:${date}`,
    metadata: {
      rank: r.rank,
      trend: r.trend,
      heatChange: r.heatChange,
      relatedJournals: r.relatedJournals.map((j) => j.name),
      sinkType: "recommendation",
      sinkDate: date,
    },
  }));

  try {
    const { accepted, rejected } = await runBatchAudit(auditInputs);
    logger.info(
      { tenantId, total: auditInputs.length, ingested: accepted.length, rejected: rejected.length },
      "钩子2: 选题推荐 → insight 沉淀完成"
    );
    return { ingested: accepted.length, rejected: rejected.length };
  } catch (err) {
    logger.error({ tenantId, err }, "钩子2: 推荐沉淀失败");
    return { ingested: 0, rejected: 0 };
  }
}

// ============ 钩子 3：生成文章 → domain_knowledge ============

/**
 * 将 AI 生成的高质量文章摘要沉淀到 domain_knowledge 子库。
 * 调用时机：content-worker handleArticleWrite 完成后（异步，非阻塞）。
 */
export async function sinkGeneratedContent(
  article: GeneratedArticle,
  tenantId: string
): Promise<{ ingested: boolean }> {
  if (article.qualityScore < SINK_LIMITS.MIN_QUALITY_SCORE) {
    logger.debug(
      { contentId: article.contentId, qualityScore: article.qualityScore },
      "钩子3: 质量分不足，跳过沉淀"
    );
    return { ingested: false };
  }

  // 截取文章摘要
  const summary = article.body.length > SINK_LIMITS.CONTENT_SUMMARY_LENGTH
    ? article.body.slice(0, SINK_LIMITS.CONTENT_SUMMARY_LENGTH) + "…"
    : article.body;

  const auditInput: AuditInput = {
    tenantId,
    category: "domain_knowledge" as VectorCategory,
    title: `已发表: ${article.title}`,
    content: [
      `标题: ${article.title}`,
      `摘要: ${summary}`,
      `目标平台: ${article.platform}`,
      `质量评分: ${article.qualityScore}`,
      article.style ? `写作风格: ${article.style}` : "",
      article.audience ? `目标受众: ${article.audience}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    source: `generated-content:${article.contentId}`,
    metadata: {
      contentId: article.contentId,
      platform: article.platform,
      qualityScore: article.qualityScore,
      style: article.style,
      planId: article.planId,
      sinkType: "generated_content",
    },
  };

  try {
    const { accepted } = await runBatchAudit([auditInput]);
    const ingested = accepted.length > 0;
    if (ingested) {
      logger.info(
        { contentId: article.contentId, title: article.title },
        "钩子3: 文章 → domain_knowledge 沉淀成功"
      );
    }
    return { ingested };
  } catch (err) {
    logger.warn({ contentId: article.contentId, err }, "钩子3: 文章沉淀失败（非阻塞）");
    return { ingested: false };
  }
}
