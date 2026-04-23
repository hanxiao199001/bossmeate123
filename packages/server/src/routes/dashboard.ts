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

      // 并行查询所有指标
      const [
        contentStats,
        tokenStats,
        knowledgeStats,
        keywordCount,
        competitorCount,
        recentContents,
        tokenTrend,
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
          date: sql<string>`DATE(${tokenLogs.createdAt})`.as("date"),
          tokens: sum(sql`${tokenLogs.inputTokens} + ${tokenLogs.outputTokens}`),
          calls: count(),
        })
        .from(tokenLogs)
        .where(and(eq(tokenLogs.tenantId, tenantId), gte(tokenLogs.createdAt, weekAgo)))
        .groupBy(sql`DATE(${tokenLogs.createdAt})`)
        .orderBy(sql`DATE(${tokenLogs.createdAt})`),
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
      },
    };
    } catch (err) {
      logger.error({ err }, "获取看板数据失败");
      return reply.code(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });
}
