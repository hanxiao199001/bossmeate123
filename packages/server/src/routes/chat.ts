import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../models/db.js";
import { conversations, messages } from "../models/schema.js";
import { logger } from "../config/logger.js";

const createConversationSchema = z.object({
  title: z.string().optional(),
  skillType: z.enum(["article", "video", "customer_service"]).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1, "消息不能为空"),
});

export async function chatRoutes(app: FastifyInstance) {
  /**
   * GET /chat/conversations - 获取对话列表
   */
  app.get("/conversations", async (request) => {
    const list = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, request.tenantId),
          eq(conversations.userId, request.user.userId)
        )
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(50);

    return { code: "OK", data: list };
  });

  /**
   * POST /chat/conversations - 创建新对话
   */
  app.post("/conversations", async (request, reply) => {
    const body = createConversationSchema.parse(request.body);

    const [conv] = await db
      .insert(conversations)
      .values({
        tenantId: request.tenantId,
        userId: request.user.userId,
        title: body.title || "新对话",
        skillType: body.skillType,
      })
      .returning();

    logger.info({ conversationId: conv.id }, "创建新对话");

    return reply.code(201).send({ code: "OK", data: conv });
  });

  /**
   * GET /chat/conversations/:id/messages - 获取对话消息历史
   */
  app.get("/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };

    const msgs = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.tenantId, request.tenantId)
        )
      )
      .orderBy(messages.createdAt);

    return { code: "OK", data: msgs };
  });

  /**
   * POST /chat/conversations/:id/send - 发送消息并获取AI回复
   *
   * TODO: 第二步实现 —— 对接 AI 模型路由器
   * 当前先存储消息，返回占位回复
   */
  app.post("/conversations/:id/send", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = sendMessageSchema.parse(request.body);

    // 验证对话归属
    const [conv] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.tenantId, request.tenantId)
        )
      )
      .limit(1);

    if (!conv) {
      return reply.code(404).send({
        code: "NOT_FOUND",
        message: "对话不存在",
      });
    }

    // 存储用户消息
    const [userMsg] = await db
      .insert(messages)
      .values({
        tenantId: request.tenantId,
        conversationId: id,
        role: "user",
        content: body.content,
      })
      .returning();

    // TODO: 调用 AI 模型路由器获取回复
    // 当前返回占位回复
    const [aiMsg] = await db
      .insert(messages)
      .values({
        tenantId: request.tenantId,
        conversationId: id,
        role: "assistant",
        content: `[AI回复占位] 收到您的消息: "${body.content.slice(0, 50)}..."。AI模型路由器将在下一步集成。`,
        model: "placeholder",
        tokensUsed: 0,
      })
      .returning();

    // 更新对话时间
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, id));

    logger.info({ conversationId: id, messageId: userMsg.id }, "消息发送成功");

    return {
      code: "OK",
      data: {
        userMessage: userMsg,
        aiMessage: aiMsg,
      },
    };
  });
}
