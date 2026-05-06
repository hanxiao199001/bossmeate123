/**
 * PR Q.0：article 用户主动操作路由（拆按钮：用户在 ContentDetailPage 手动点
 * "🎬 生成视频" 后调本路由触发 video script 生成；不再走 chat.ts auto-bridge）。
 */
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { triggerVideoFromArticle } from "../services/skills/auto-video-bridge.js";
import { getProvider } from "../services/ai/provider-factory.js";

export async function articlesRoutes(app: FastifyInstance) {
  // POST /articles/:id/generate-video — 用户手动触发 article → video script 生成
  app.post("/:id/generate-video", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [article] = await db
      .select()
      .from(contents)
      .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
      .limit(1);
    if (!article || article.type !== "article") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "article 不存在" });
    }
    const journalId = (article.metadata as { journalId?: unknown } | null)?.journalId;
    if (typeof journalId !== "string" || journalId.length === 0) {
      return reply.code(400).send({
        code: "NO_JOURNAL_ID",
        message: "article 未关联 journalId，无法生成视频（多发生在 V6 DB 未命中走 AI 合成的场景）",
      });
    }
    const provider = getProvider("expensive") || getProvider("cheap");
    if (!provider) {
      return reply.code(503).send({ code: "NO_PROVIDER", message: "无可用 AI provider" });
    }
    void triggerVideoFromArticle({
      provider,
      db,
      journalId,
      tenantId: request.tenantId,
      userId: request.user.userId,
      articleContentId: article.id,
      conversationId: article.conversationId ?? null,
    });
    logger.info({ articleId: id, journalId }, "Q.0 user-triggered article→video");
    return { code: "OK", data: { articleId: id, journalId, status: "triggered" } };
  });
}
