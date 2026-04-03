/**
 * 每日选题推荐 API
 */

import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../models/db.js";
import { conversations, messages, dailyRecommendations } from "../models/schema.js";
import {
  getTodayRecommendations,
  getRecommendationHistory,
  type TopicRecommendation,
} from "../services/content-engine/topic-recommender.js";

export async function recommendationRoutes(app: FastifyInstance) {
  // GET /recommendations/today
  app.get("/today", async (request) => {
    const tenantId = request.tenantId;
    const report = await getTodayRecommendations(tenantId);
    return { code: "OK", data: report };
  });

  // GET /recommendations/history?days=7
  app.get("/history", async (request) => {
    const tenantId = request.tenantId;
    const { days = "7" } = request.query as { days?: string };
    const history = await getRecommendationHistory(tenantId, parseInt(days));
    return { code: "OK", data: history };
  });

  // POST /recommendations/create-from/:id — 一键创作
  app.post("/create-from/:id", async (request, reply) => {
    const tenantId = request.tenantId;
    const { id } = request.params as { id: string };
    const today = new Date().toISOString().slice(0, 10);

    // 查找今日推荐
    const [record] = await db
      .select()
      .from(dailyRecommendations)
      .where(
        and(
          eq(dailyRecommendations.tenantId, tenantId),
          eq(dailyRecommendations.date, today)
        )
      )
      .limit(1);

    if (!record) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "今日推荐不存在" });
    }

    const recs = record.recommendations as TopicRecommendation[];
    const rec = recs.find((r) => r.id === id);
    if (!rec) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "推荐不存在" });
    }

    // 创建对话
    const [conv] = await db.insert(conversations).values({
      tenantId,
      userId: request.user.userId,
      title: `${rec.keyword} - 选题创作`,
      skillType: "article",
      metadata: { fromRecommendation: rec.id },
    }).returning();

    // 组装第一条用户消息
    const autoMessage =
      `请帮我写一篇关于「${rec.createParams.topic}」的文章，` +
      `${rec.createParams.suggestedWordCount}字左右，` +
      `面向${rec.createParams.suggestedAudience}。` +
      (rec.relatedJournals.length > 0
        ? `请重点参考${rec.relatedJournals[0].name}等期刊的最新研究。`
        : "") +
      (rec.createParams.keywords.length > 1
        ? `涉及关键词：${rec.createParams.keywords.join("、")}。`
        : "");

    // 存入 messages
    await db.insert(messages).values({
      tenantId,
      conversationId: conv.id,
      role: "user",
      content: autoMessage,
    });

    return {
      code: "OK",
      data: {
        conversationId: conv.id,
        autoMessage,
      },
    };
  });
}
