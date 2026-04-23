import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, sql, count } from "drizzle-orm";
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
   * GET /content - 获取内容列表（支持筛选和分页）
   */
  app.get("/", async (request, reply) => {
    try {
      const query = request.query as {
        type?: string;
        status?: string;
        userId?: string;
        page?: string;
        pageSize?: string;
      };

      const page = Math.max(1, parseInt(query.page || "1", 10));
      const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || "20", 10)));
      const offset = (page - 1) * pageSize;

      const conditions = [eq(contents.tenantId, request.tenantId)];

      // 如果指定了 userId 筛选，验证权限（owner/admin 可查看全部，其他用户只能查看自己的）
      if (query.userId) {
        const userRole = request.user.role as string;
        if (userRole !== "owner" && userRole !== "admin") {
          // 非管理员只能查看自己的内容
          if (query.userId !== request.user.userId) {
            return reply.code(403).send({
              code: "FORBIDDEN",
              message: "无权限查看其他用户的内容",
            });
          }
        }
        conditions.push(eq(contents.userId, query.userId));
      }

      if (query.type && ["article", "video_script", "reply"].includes(query.type)) {
        conditions.push(eq(contents.type, query.type));
      }

      if (query.status && ["draft", "reviewing", "approved", "published"].includes(query.status)) {
        conditions.push(eq(contents.status, query.status));
      }

      const whereClause = and(...conditions);

      const [list, totalResult] = await Promise.all([
        db
          .select()
          .from(contents)
          .where(whereClause)
          .orderBy(desc(contents.updatedAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ total: count() })
          .from(contents)
          .where(whereClause),
      ]);

      const total = totalResult[0]?.total || 0;

      // Note: userId in response indicates who created the content (createdBy)
      return {
        code: "OK",
        data: {
          items: list,
          total,
          page,
          pageSize,
        },
      };
    } catch (err) {
      logger.error({ err }, "获取内容列表失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /content/stats - 获取内容统计（各状态数量）
   */
  app.get("/stats", async (request, reply) => {
    try {
      const result = await db
        .select({
          status: contents.status,
          type: contents.type,
          count: count(),
        })
        .from(contents)
        .where(eq(contents.tenantId, request.tenantId))
        .groupBy(contents.status, contents.type);

      // 聚合为更友好的格式
      const stats = {
        total: 0,
        byStatus: {} as Record<string, number>,
        byType: {} as Record<string, number>,
      };

      for (const row of result) {
        const c = Number(row.count);
        stats.total += c;
        stats.byStatus[row.status] = (stats.byStatus[row.status] || 0) + c;
        stats.byType[row.type] = (stats.byType[row.type] || 0) + c;
      }

      return { code: "OK", data: stats };
    } catch (err) {
      logger.error({ err }, "获取内容统计失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /content - 创建内容
   */
  app.post("/", async (request, reply) => {
    try {
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
    } catch (err) {
      logger.error({ err }, "创建内容失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /content/:id - 获取单个内容
   */
  app.get("/:id", async (request, reply) => {
    try {
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
    } catch (err) {
      logger.error({ err }, "获取内容详情失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * PATCH /content/:id - 更新内容（人工二次编辑）
   * 权限：内容创建者或 owner/admin 可编辑
   */
  app.patch("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateContentSchema.parse(request.body);

      // 先获取内容，验证权限
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

      // 权限检查：内容创建者或 owner/admin
      const userRole = request.user.role as string;
      const isCreator = content.userId === request.user.userId;
      const isAdmin = userRole === "owner" || userRole === "admin";

      if (!isCreator && !isAdmin) {
        return reply.code(403).send({
          code: "FORBIDDEN",
          message: "无权限编辑此内容",
        });
      }

      const [updated] = await db
        .update(contents)
        .set({
          ...body,
          updatedAt: new Date(),
        })
        .where(eq(contents.id, id))
        .returning();

      logger.info({ contentId: id, userId: request.user.userId }, "内容更新成功");

      return { code: "OK", data: updated };
    } catch (err) {
      logger.error({ err }, "更新内容失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * DELETE /content/:id - 删除内容
   */
  app.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const [deleted] = await db
        .delete(contents)
        .where(
          and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
        )
        .returning();

      if (!deleted) {
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "内容不存在",
        });
      }

      logger.info({ contentId: id }, "内容删除成功");

      return { code: "OK", data: { id } };
    } catch (err) {
      logger.error({ err }, "删除内容失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });
}
