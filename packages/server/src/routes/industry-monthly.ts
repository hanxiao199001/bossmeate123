/**
 * P5 industry-monthly admin routes（5-14 V2 P5）。
 *
 * POST /api/v1/admin/industry-monthly/trigger
 *   body: { industry: 'medical' | 'it' | 'law' | 'education' | 'all' }
 *   admin only（cron 每月 1 号才自动跑，admin 手动测试入口）
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { runIndustryBatch, runAllIndustriesMonthly } from "../services/industry-monthly/cron-handler.js";
import { INDUSTRIES, type Industry } from "../services/industry-monthly/topic-generator.js";

const triggerBodySchema = z.object({
  industry: z.enum(["medical", "it", "law", "education", "all"]),
});

function isAdmin(role: unknown): boolean {
  return role === "owner" || role === "admin";
}

export async function industryMonthlyRoutes(app: FastifyInstance) {
  app.post("/admin/industry-monthly/trigger", async (request, reply) => {
    if (!isAdmin(request.user.role)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "需要 admin 角色" });
    }
    let parsed: z.infer<typeof triggerBodySchema>;
    try {
      parsed = triggerBodySchema.parse(request.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }

    try {
      const args = { tenantId: request.tenantId, userId: request.user.userId };
      let results;
      if (parsed.industry === "all") {
        results = await runAllIndustriesMonthly(args);
      } else {
        results = [await runIndustryBatch({ ...args, industry: parsed.industry as Industry })];
      }
      logger.info({ tenantId: request.tenantId, industries: results.length }, "P5 admin trigger 完成");
      return { code: "OK", data: { results } };
    } catch (err) {
      logger.error({ err }, "P5 admin trigger 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  });

  /** 简单 GET 看支持的 industries（前端可选下拉用） */
  app.get("/admin/industry-monthly/industries", async (request, reply) => {
    if (!isAdmin(request.user.role)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "需要 admin 角色" });
    }
    return { code: "OK", data: { industries: INDUSTRIES } };
  });
}
