/**
 * 数据看板路由
 * 聚合知识库、内容生产、Token 消耗等全局指标
 */
import type { FastifyInstance } from "fastify";
import { eq, and, desc, sql, count, sum, gte } from "drizzle-orm";
import { db } from "../models/db.js";
import { logger } from "../config/logger.js";
import {
  contents,
  tokenLogs,
  knowledgeEntries,
  keywords,
  competitors,
  distributionRecords,
  productionRecords,
  contentMetrics,
} from "../models/schema.js";
import { getStats } from "../services/knowledge/knowledge-service.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";

export async function dashboardRoutes(app: FastifyInstance) {
  /**
   * GET /dashboard/overview — 全局概览数据
   */
  app.get("/overview", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      // 5-17 P0 hero: today 用 BJ 时区算（user spec 期望"今日 = 当天 BJ"），
      // 简化：取 now (BJ vs UTC 差 8h，今日 system tenant 推荐文章是 cron 03:00 BJ 出，UTC 19:00 前一天)
      // 直接用 24h 滚动窗口避免时区坑
      const todayStartBJ = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // 并行查询所有指标
      const [
        contentStats,
        tokenStats,
        knowledgeStats,
        keywordCount,
        competitorCount,
        recentContents,
        tokenTrend,
        heroSystemArticlesToday,
        heroKeywords24h,
        heroArticlesGen24h,
        heroArticlesPub24h,
        heroLatestArticle,
        heroRecentPublished,
        heroRealReads,
      ] = await Promise.all([
      // 内容统计
      db
        .select({
          total: count(),
          drafts: count(sql`CASE WHEN ${contents.status} = 'draft' THEN 1 END`),
          published: count(sql`CASE WHEN ${contents.status} = 'published' THEN 1 END`),
          reviewing: count(sql`CASE WHEN ${contents.status} = 'reviewing' THEN 1 END`),
        })
        .from(contents)
        .where(eq(contents.tenantId, tenantId)),

      // Token 消耗（最近7天）
      db
        .select({
          totalInput: sum(tokenLogs.inputTokens),
          totalOutput: sum(tokenLogs.outputTokens),
          callCount: count(),
        })
        .from(tokenLogs)
        .where(and(eq(tokenLogs.tenantId, tenantId), gte(tokenLogs.createdAt, weekAgo))),

      // 知识库统计
      getStats(tenantId),

      // 关键词总数
      db
        .select({ count: count() })
        .from(keywords)
        .where(eq(keywords.tenantId, tenantId)),

      // 竞品数量
      db
        .select({ count: count() })
        .from(competitors)
        .where(eq(competitors.tenantId, tenantId)),

      // 最近内容（最新5条）
      db
        .select({
          id: contents.id,
          title: contents.title,
          type: contents.type,
          status: contents.status,
          tokensTotal: contents.tokensTotal,
          createdAt: contents.createdAt,
          metadata: contents.metadata,
        })
        .from(contents)
        .where(eq(contents.tenantId, tenantId))
        .orderBy(desc(contents.createdAt))
        .limit(5),

      // Token 趋势（最近7天，按天聚合）
      db
        .select({
          // 8-02: token_logs.created_at 是 NAIVE(存 UTC), 裸 DATE() 得到 UTC 日 → 标签整体偏一天
          date: sql<string>`DATE(${tokenLogs.createdAt} + interval '8 hours')`.as("date"),
          tokens: sum(sql`${tokenLogs.inputTokens} + ${tokenLogs.outputTokens}`),
          calls: count(),
        })
        .from(tokenLogs)
        .where(and(eq(tokenLogs.tenantId, tenantId), gte(tokenLogs.createdAt, weekAgo)))
        .groupBy(sql`DATE(${tokenLogs.createdAt} + interval '8 hours')`)
        .orderBy(sql`DATE(${tokenLogs.createdAt} + interval '8 hours')`),

      // 5-17 P0 hero: 今日 system tenant 推荐文章 (24h 滚动窗口避免时区坑)
      db.select({ c: count() }).from(contents)
        .where(and(eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID), eq(contents.type, "article"), gte(contents.createdAt, todayStartBJ))),

      // hero pipeline24h.keywordsCrawled: 全 tenant 求和（user 5-17 决策 B，叙事"系统活着"）
      db.select({ c: count() }).from(keywords).where(gte(keywords.createdAt, dayAgo)),

      // hero pipeline24h.articlesGenerated: 限 SYSTEM tenant (daily-cron 产出)
      db.select({ c: count() }).from(contents)
        .where(and(eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID), eq(contents.type, "article"), gte(contents.createdAt, dayAgo))),

      // hero pipeline24h.articlesPublished: caller tenant 24h published
      db.select({ c: count() }).from(contents)
        .where(and(eq(contents.tenantId, tenantId), eq(contents.status, "published"), gte(contents.updatedAt, dayAgo))),

      // hero latestArticlePreview: SYSTEM tenant 最新 1 篇 (coverUrl 留 null, 前端 emoji fallback)
      db.select({ id: contents.id, title: contents.title, createdAt: contents.createdAt })
        .from(contents)
        .where(and(eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID), eq(contents.type, "article")))
        .orderBy(desc(contents.createdAt)).limit(1),

      // hero recentPublished: caller tenant 最近 3 条 published (platform 从 platforms jsonb 第一项取)
      db.select({ id: contents.id, title: contents.title, platforms: contents.platforms, updatedAt: contents.updatedAt })
        .from(contents)
        .where(and(eq(contents.tenantId, tenantId), eq(contents.status, "published")))
        .orderBy(desc(contents.updatedAt)).limit(3),

      // 7-06 ④: 拔 8500 假数据 — 昨日以来真实回流阅读求和。
      //   wechat-stats-collector 写 content_metrics 时把"当日阅读增量"存 metadata.dailyReadDelta
      //   (views 列是累计快照, 直接 SUM 会重复计); 运营手填行无 delta 用 views 兜底。无回流数据 = 0。
      db.execute(sql`
        SELECT COALESCE(SUM(COALESCE((cm.metadata->>'dailyReadDelta')::int, cm.views)), 0) AS total
        FROM content_metrics cm
        WHERE cm.tenant_id = ${tenantId}
          AND cm.snapshot_date >= (CURRENT_DATE - 1)`),
    ]);

    // 知识库汇总
    const kbEntries = knowledgeStats;
    const kbTotal = Object.values(kbEntries).reduce((s, v) => s + v.pgCount, 0);
    const kbVectorized = Object.values(kbEntries).reduce((s, v) => s + v.vectorCount, 0);
    const kbActiveLibs = Object.values(kbEntries).filter((v) => v.pgCount > 0).length;

    return {
      success: true,
      data: {
        // 内容生产
        content: {
          total: contentStats[0]?.total ?? 0,
          drafts: contentStats[0]?.drafts ?? 0,
          published: contentStats[0]?.published ?? 0,
          reviewing: contentStats[0]?.reviewing ?? 0,
        },
        // Token 消耗
        tokens: {
          weeklyInput: Number(tokenStats[0]?.totalInput ?? 0),
          weeklyOutput: Number(tokenStats[0]?.totalOutput ?? 0),
          weeklyTotal: Number(tokenStats[0]?.totalInput ?? 0) + Number(tokenStats[0]?.totalOutput ?? 0),
          weeklyCalls: Number(tokenStats[0]?.callCount ?? 0),
          trend: tokenTrend.map((t) => ({
            date: t.date,
            tokens: Number(t.tokens ?? 0),
            calls: Number(t.calls ?? 0),
          })),
        },
        // 知识库
        knowledge: {
          totalEntries: kbTotal,
          vectorizedEntries: kbVectorized,
          activeLibraries: kbActiveLibs,
          totalLibraries: 16,
          coverageRate: kbTotal > 0 ? Math.round((kbVectorized / kbTotal) * 100) : 0,
          breakdown: kbEntries,
        },
        // 资源
        resources: {
          keywords: keywordCount[0]?.count ?? 0,
          competitors: competitorCount[0]?.count ?? 0,
        },
        // 最近内容
        recentContents: recentContents.map((c) => ({
          id: c.id,
          title: c.title || "(无标题)",
          type: c.type,
          status: c.status,
          tokens: c.tokensTotal,
          qualityScore: (c.metadata as any)?.quality?.score,
          createdAt: c.createdAt,
        })),
        // 5-17 P0 hero: 老板视角的"系统活着 + 产能 + ROI"
        todayHero: {
          systemTenantArticlesToday: Number(heroSystemArticlesToday[0]?.c ?? 0),
          pipeline24h: {
            keywordsCrawled: Number(heroKeywords24h[0]?.c ?? 0),
            articlesGenerated: Number(heroArticlesGen24h[0]?.c ?? 0),
            articlesPublished: Number(heroArticlesPub24h[0]?.c ?? 0),
            // 7-06 ④: 真实回流数据 (昨日+今日快照阅读增量求和); 没有回流数据 = 0, 前端显示"暂无回流数据"
            totalReadsToday: Number(((heroRealReads as any).rows?.[0]?.total) ?? 0),
          },
          latestArticlePreview: heroLatestArticle[0]
            ? { id: heroLatestArticle[0].id, title: heroLatestArticle[0].title || "(无标题)", coverUrl: null, createdAt: heroLatestArticle[0].createdAt }
            : null,
          recentPublished: heroRecentPublished.map((r) => {
            const platformsArr = Array.isArray(r.platforms) ? r.platforms : [];
            const firstPlatform = (platformsArr[0] as { platform?: string } | undefined)?.platform;
            return { id: r.id, title: r.title || "(无标题)", platform: firstPlatform || "multi", publishedAt: r.updatedAt };
          }),
        },
      },
    };
    } catch (err) {
      logger.error({ err }, "获取看板数据失败");
      return reply.code(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });
}
