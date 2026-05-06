/**
 * PR Q.2：内容模板路由（admin UI 用）。
 * GET /content-templates — 列表（全局 + 该 tenant 自定义）
 * GET /content-templates/:id — 详情
 *
 * 注意：D1 简化版只 list + select；模板的 css_theme + prompt_overrides 实际生效要等 D2
 *      template-registry 改 DB-driven。本 PR 只做 schema + admin UI list 这一层。
 */
import type { FastifyInstance } from "fastify";
import { eq, or, isNull, and } from "drizzle-orm";
import { db } from "../models/db.js";
import { contentTemplates } from "../models/schema.js";
import { logger } from "../config/logger.js";

export async function contentTemplatesRoutes(app: FastifyInstance) {
  // GET / — 该 tenant 可见的所有模板（全局 NULL + 自有）
  app.get("/", async (request) => {
    const list = await db
      .select()
      .from(contentTemplates)
      .where(or(isNull(contentTemplates.tenantId), eq(contentTemplates.tenantId, request.tenantId)))
      .orderBy(contentTemplates.styleTag, contentTemplates.name);
    return { code: "OK", data: list };
  });

  // GET /:id
  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db
      .select()
      .from(contentTemplates)
      .where(and(
        eq(contentTemplates.id, id),
        or(isNull(contentTemplates.tenantId), eq(contentTemplates.tenantId, request.tenantId)),
      ))
      .limit(1);
    if (!row) return reply.code(404).send({ code: "NOT_FOUND", message: "模板不存在" });
    return { code: "OK", data: row };
  });

  logger.info("content-templates routes registered");
}
