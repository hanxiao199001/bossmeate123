/**
 * PR Q.0：article 用户主动操作路由（拆按钮：用户在 ContentDetailPage 手动点
 * "🎬 生成视频" 后调本路由触发 video script 生成；不再走 chat.ts auto-bridge）。
 *
 * PR #140 (5-14)：新增 POST /:id/generate-dvh-video — 用户主动触发 article → 阿里数字人视频。
 * 前端 wire 留 PR #141 (UI tile + batch 调度 + 工时对比页)。
 */
import type { FastifyInstance } from "fastify";
import { eq, and, or } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { triggerVideoFromArticle } from "../services/skills/auto-video-bridge.js";
import { getProvider } from "../services/ai/provider-factory.js";
import {
  triggerDvhFromArticle,
  TEMPLATE_AVATAR_VOICE_MAP,
  isRealMode,
  type TemplateId,
} from "../services/digital-human/index.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";

export async function articlesRoutes(app: FastifyInstance) {
  // POST /articles/:id/generate-video — 用户手动触发 article → video script 生成
  app.post("/:id/generate-video", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [article] = await db
      .select()
      .from(contents)
      .where(and(
        eq(contents.id, id),
        // 跟 publishToAccounts (PR #143) 一致：放开 system 推荐文章，让用户能从推荐 feed 触发
        or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      ))
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

  // POST /articles/:id/generate-dvh-video — 用户手动触发 article → 阿里数字人视频 (PR #140)
  app.post("/:id/generate-dvh-video", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { templateId?: string } | null) || {};

    const [article] = await db
      .select()
      .from(contents)
      .where(and(
        eq(contents.id, id),
        // 跟 publishToAccounts (PR #143) 一致：放开 system 推荐文章，让用户能从推荐 feed 触发
        or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      ))
      .limit(1);
    if (!article || article.type !== "article") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "article 不存在" });
    }

    const metaTemplateId = (article.metadata as { templateId?: string } | null)?.templateId;
    const templateId = body.templateId || metaTemplateId;
    if (!templateId || !(templateId in TEMPLATE_AVATAR_VOICE_MAP)) {
      return reply.code(400).send({
        code: "NO_TEMPLATE_ID",
        message: `templateId 缺失或非法 (${templateId ?? "null"})，需 4 主播之一: ${Object.keys(TEMPLATE_AVATAR_VOICE_MAP).join(", ")}`,
      });
    }

    if (isRealMode() && (!process.env.DVH_TENANT_ID || !process.env.DVH_APP_ID)) {
      return reply.code(503).send({
        code: "NO_DVH",
        message: "DVH_REAL_MODE=true 但 DVH_TENANT_ID / DVH_APP_ID 缺失",
      });
    }

    void triggerDvhFromArticle({
      db,
      tenantId: request.tenantId,
      userId: request.user.userId,
      articleContentId: article.id,
      templateId: templateId as TemplateId,
      conversationId: article.conversationId ?? null,
      journalId: (article.metadata as { journalId?: string } | null)?.journalId,
    });
    logger.info(
      { articleId: id, templateId, realMode: isRealMode() },
      "PR #140 user-triggered article→DVH",
    );
    return { code: "OK", data: { articleId: id, templateId, status: "triggered", realMode: isRealMode() } };
  });
}
