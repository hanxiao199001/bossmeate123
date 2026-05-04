/**
 * 匿名公开路由 —— PR B.9
 *
 * - POST /match-journals    AI 推 5 本最对口期刊（rate-limit 10/IP/min）
 * - POST /telemetry         埋点（viewed / signup_clicked），rate-limit 30/IP/min
 *
 * 无 JWT / 无 tenant middleware（在 index.ts 注册时已隔离）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { matchJournalsPublic, matchSchema } from "../services/journals/match-public.js";

const telemetrySchema = z.object({
  event: z.enum(["viewed", "signup_clicked"]),
});

export async function publicRoutes(app: FastifyInstance) {
  app.post("/match-journals", async (request, reply) => {
    const parsed = matchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "abstract 参数错" });
    }
    try {
      const matches = await matchJournalsPublic(parsed.data.abstract);
      logger.info({ ip: request.ip, count: matches.length }, "[public.matched]");
      return reply.send({ matches });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "[public.match.failed]");
      return reply.code(503).send({ error: "AI 匹配暂不可用，请稍候重试" });
    }
  });

  app.post("/telemetry", async (request, reply) => {
    const parsed = telemetrySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "event 参数错" });
    logger.info({ ip: request.ip, event: parsed.data.event }, `[public.${parsed.data.event}]`);
    return reply.send({ ok: true });
  });
}
