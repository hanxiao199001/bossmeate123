/**
 * P3 AI 推荐 API（5-10 backend Day 1）。
 *
 *   GET /api/v1/recommend/journals?topic=xxx&limit=5
 *   GET /api/v1/recommend/topics?journalId=uuid&limit=5
 *
 * Auth：通过 protectedApp（已经走 authMiddleware + tenantMiddleware）。
 * Cache：30 分钟 TTL（in-memory，cache.ts）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { recommendJournals } from "../services/recommendation/journal-recommender.js";
import { recommendTopics } from "../services/recommendation/topic-recommender.js";

const journalsQuerySchema = z.object({
  topic: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

const topicsQuerySchema = z.object({
  journalId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export async function recommendRoutes(app: FastifyInstance) {
  /** P3：基于 user 历史 + topic → top N 期刊推荐 */
  app.get("/recommend/journals", async (request, reply) => {
    let parsed: z.infer<typeof journalsQuerySchema>;
    try {
      parsed = journalsQuerySchema.parse(request.query);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }

    try {
      const items = await recommendJournals({
        tenantId: request.tenantId,
        topic: parsed.topic,
        limit: parsed.limit,
      });
      return { code: "OK", data: { items, total: items.length } };
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId }, "P3 recommend/journals 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "推荐失败" });
    }
  });

  /** P3：基于 journal + user 历史 → top N 主题推荐 */
  app.get("/recommend/topics", async (request, reply) => {
    let parsed: z.infer<typeof topicsQuerySchema>;
    try {
      parsed = topicsQuerySchema.parse(request.query);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }

    try {
      const items = await recommendTopics({
        tenantId: request.tenantId,
        journalId: parsed.journalId,
        limit: parsed.limit,
      });
      return { code: "OK", data: { items, total: items.length } };
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId }, "P3 recommend/topics 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "推荐失败" });
    }
  });
}
