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
import { eq, and, gte } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { adminOnlyMiddleware } from "../middleware/admin-only.js";
import { createBatch } from "../services/batch/batch-service.js";
import { recommendJournals } from "../services/recommendation/journal-recommender.js";
import { logger } from "../config/logger.js";

const generateArticleSchema = z.object({
  topic: z.string().min(2).max(100),
  journalId: z.string().uuid().optional(),
  template: z.enum(["A", "B", "C", "E"]).default("A"),
});

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
}
