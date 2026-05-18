/**
 * 5-23 PR #161 — admin-only 路由 (Workbench v2 + bulk-distribute).
 *
 * 全部 endpoint 经 adminOnlyMiddleware 守 (role in {owner, admin}, 否则 403).
 *
 * 当前 endpoint:
 *   POST /admin/generate-article  — 单文章手动生成 (复用 createBatch)
 *   (POST /admin/generate-video 在 Day 2 上午加)
 *   (POST /admin/bulk-distribute + SSE 在 Day 2 下午加)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, gte, or } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals, contents } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { adminOnlyMiddleware } from "../middleware/admin-only.js";
import { createBatch } from "../services/batch/batch-service.js";
import { recommendJournals } from "../services/recommendation/journal-recommender.js";
import { triggerDvhFromArticle } from "../services/digital-human/article-bridge.js";
import { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId } from "../services/digital-human/template-mapping.js";
import { isRealMode } from "../services/digital-human/client.js";
import { logger } from "../config/logger.js";

const generateArticleSchema = z.object({
  topic: z.string().min(2).max(100),
  journalId: z.string().uuid().optional(),
  template: z.enum(["A", "B", "C", "E"]).default("A"),
});

const generateVideoSchema = z.object({
  source: z.enum(["from_article", "from_topic"]),
  articleId: z.string().uuid().optional(),
  topic: z.string().min(2).max(100).optional(),
  avatarTemplate: z.enum(["A_academic", "B_marketing", "C_popular", "E_industry"]).default("A_academic"),
}).refine(
  (d) => (d.source === "from_article" ? !!d.articleId : !!d.topic),
  { message: "from_article 需 articleId; from_topic 需 topic" }
);

// 期刊 confidence 下限 (admin 生成时只用高质量期刊数据)
const MIN_JOURNAL_CONFIDENCE = 90;

export async function adminRoutes(app: FastifyInstance) {
  // 所有 /admin/* 路由先经 adminOnlyMiddleware
  app.addHook("preHandler", adminOnlyMiddleware);

  /**
   * POST /admin/generate-article
   * body: { topic: string, journalId?: uuid, template?: 'A'|'B'|'C'|'E' }
   * 返回: { batchId, contentId(待 worker 完成), estimatedSeconds: 60 }
   *
   * 行为:
   *   1. 若 journalId 提供: 校验 journals where id=? AND confidence>=90
   *   2. 若 journalId 不提供: recommendJournals top1 (tenantId=request.tenantId)
   *   3. createBatch(priority=1, rows=[{topic, journalId, template}])
   *   4. 返回 batchId, 前端 poll /batch/:id/status 至 ready 拿 contentId
   */
  app.post("/generate-article", async (request, reply) => {
    try {
      const body = generateArticleSchema.parse(request.body);

      // 1. 决定 journalId
      let journalId = body.journalId;
      if (journalId) {
        const [j] = await db
          .select({ id: journals.id, confidence: journals.confidence })
          .from(journals)
          .where(and(eq(journals.id, journalId), gte(journals.confidence, MIN_JOURNAL_CONFIDENCE)))
          .limit(1);
        if (!j) {
          return reply.code(400).send({
            code: "JOURNAL_NOT_QUALIFIED",
            message: `期刊不存在或 confidence < ${MIN_JOURNAL_CONFIDENCE}`,
          });
        }
      } else {
        // 自动选 top1
        const recs = await recommendJournals({
          tenantId: request.tenantId,
          topic: body.topic,
          limit: 1,
        });
        if (recs.length === 0 || !recs[0]) {
          return reply.code(400).send({
            code: "NO_JOURNAL_MATCH",
            message: `无法为 topic '${body.topic}' 匹配到合适期刊, 请手动指定 journalId`,
          });
        }
        journalId = recs[0].id;
      }

      // 2. createBatch (priority=1 最高优先)
      const filename = `manual-${body.topic.slice(0, 20)}-${Date.now()}`;
      const result = await createBatch({
        tenantId: request.tenantId,
        userId: request.user.userId,
        filename,
        rows: [{ rowIndex: 1, topic: body.topic, journalId, template: body.template, priority: 1 }],
      });

      logger.info(
        { batchId: result.batchId, topic: body.topic, journalId, template: body.template, userId: request.user.userId },
        "PR #161 admin generate-article 入队"
      );

      return {
        code: "OK",
        data: {
          batchId: result.batchId,
          estimatedSeconds: 60,
        },
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #161 generate-article 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "生成失败, 请稍后重试" });
    }
  });

  /**
   * POST /admin/generate-video
   * body: { source: 'from_article'|'from_topic', articleId?, topic?, avatarTemplate? }
   *
   * 双路径:
   *   from_article: 校验 articleId 存在 → triggerDvhFromArticle (复用 PR #140 链路)
   *                 返 { mode: 'direct', articleId, templateId, estimatedSeconds: 180 }
   *   from_topic:   createBatch 生成 article → 返 { mode: 'pending_article', batchId, templateId, estimatedSeconds: 240 }
   *                 client 后续 poll /batch/:id 拿 articleId, 自行调 POST /articles/:id/generate-dvh-video
   *                 (避免本 endpoint 长连阻塞 + 保 createBatch 与 dvh 解耦)
   */
  app.post("/generate-video", async (request, reply) => {
    try {
      const body = generateVideoSchema.parse(request.body);
      const templateId = body.avatarTemplate as TemplateId;
      if (!(templateId in TEMPLATE_AVATAR_VOICE_MAP)) {
        return reply.code(400).send({ code: "BAD_TEMPLATE", message: `avatarTemplate 非法: ${templateId}` });
      }
      if (isRealMode() && (!process.env.DVH_TENANT_ID || !process.env.DVH_APP_ID)) {
        return reply.code(503).send({ code: "NO_DVH", message: "DVH_REAL_MODE=true 但 DVH 凭证缺失" });
      }

      if (body.source === "from_article" && body.articleId) {
        // 路径 A: 现有 article 直接生成视频 (复用 PR #140)
        const [article] = await db
          .select()
          .from(contents)
          .where(and(
            eq(contents.id, body.articleId),
            or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
          ))
          .limit(1);
        if (!article || article.type !== "article") {
          return reply.code(404).send({ code: "NOT_FOUND", message: "article 不存在" });
        }
        void triggerDvhFromArticle({
          db,
          tenantId: request.tenantId,
          userId: request.user.userId,
          articleContentId: article.id,
          templateId,
          conversationId: article.conversationId ?? null,
          journalId: (article.metadata as { journalId?: string } | null)?.journalId,
        });
        logger.info({ articleId: body.articleId, templateId, realMode: isRealMode() }, "PR #161 admin generate-video (from_article)");
        return {
          code: "OK",
          data: { mode: "direct", articleId: body.articleId, templateId, estimatedSeconds: 180 },
        };
      }

      // 路径 B: from_topic, 先生成 article (top1 推荐期刊, 模板 A)
      const recs = await recommendJournals({ tenantId: request.tenantId, topic: body.topic!, limit: 1 });
      const journalId = recs[0]?.id;
      if (!journalId) {
        return reply.code(400).send({ code: "NO_JOURNAL_MATCH", message: `无法为 topic '${body.topic}' 匹配期刊` });
      }
      const filename = `manual-video-${body.topic!.slice(0, 20)}-${Date.now()}`;
      const result = await createBatch({
        tenantId: request.tenantId,
        userId: request.user.userId,
        filename,
        rows: [{ rowIndex: 1, topic: body.topic!, journalId, template: "A", priority: 1 }],
      });
      logger.info({ batchId: result.batchId, topic: body.topic, templateId }, "PR #161 admin generate-video (from_topic) batch 已入队");
      return {
        code: "OK",
        data: {
          mode: "pending_article",
          batchId: result.batchId,
          templateId,
          estimatedSeconds: 240, // 60s article + 180s video
        },
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #161 generate-video 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "视频生成请求失败" });
    }
  });
}
