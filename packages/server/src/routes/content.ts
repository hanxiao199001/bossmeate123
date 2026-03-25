import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { logger } from "../config/logger.js";

const createContentSchema = z.object({
  type: z.enum(["article", "video_script", "reply"]),
  title: z.string().optional(),
  body: z.string().optional(),
  conversationId: z.string().uuid().optional(),
});

const updateContentSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  status: z.enum(["draft", "reviewing", "approved", "published"]).optional(),
});

export async function contentRoutes(app: FastifyInstance) {
  /**
   * GET /content - 获取内容列表
   */
  app.get("/", async (request) => {
    const query = request.query as { type?: string; status?: string };

    let conditions = [eq(contents.tenantId, request.tenantId)];

    const list = await db
      .select()
      .from(contents)
      .where(and(...conditions))
      .orderBy(desc(contents.updatedAt))
      .limit(100);

    return { code: "OK", data: list };
  });

  /**
   * POST /content - 创建内容
   */
  app.post("/", async (request, reply) => {
    const body = createContentSchema.parse(request.body);

    const [content] = await db
      .insert(contents)
      .values({
        tenantId: request.tenantId,
        userId: request.user.userId,
        type: body.type,
        title: body.title,
        body: body.body,
        conversationId: body.conversationId,
      })
      .returning();

    logger.info({ contentId: content.id, type: body.type }, "内容创建成功");

    return reply.code(201).send({ code: "OK", data: content });
  });

  /**
   * GET /content/:id - 获取单个内容
   */
  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [content] = await db
      .select()
      .from(contents)
      .where(
        and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
      )
      .limit(1);

    if (!content) {
      return reply.code(404).send({
        code: "NOT_FOUND",
        message: "内容不存在",
      });
    }

    return { code: "OK", data: content };
  });

  /**
   * PATCH /content/:id - 更新内容（人工二次编辑）
   */
  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateContentSchema.parse(request.body);

    const [updated] = await db
      .update(contents)
      .set({
        ...body,
        updatedAt: new Date(),
      })
      .where(
        and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
      )
      .returning();

    if (!updated) {
      return reply.code(404).send({
        code: "NOT_FOUND",
        message: "内容不存在",
      });
    }

    logger.info({ contentId: id }, "内容更新成功");

    return { code: "OK", data: updated };
  });
}
