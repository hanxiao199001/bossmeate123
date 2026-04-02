/**
 * 对话路由 - 集成图文线 Skill 和真实 AI 调用
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../models/db.js";
import { conversations, messages, contents, tokenLogs } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { getProvider } from "../services/ai/provider-factory.js";
import { SkillRegistry } from "../services/skills/index.js";

const createConversationSchema = z.object({
  title: z.string().optional(),
  skillType: z.enum(["article", "video", "customer_service"]).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1, "消息不能为空"),
});

export async function chatRoutes(app: FastifyInstance) {
  // 获取对话列表
  app.get("/conversations", async (request) => {
    const list = await db.select().from(conversations)
      .where(and(eq(conversations.tenantId, request.tenantId), eq(conversations.userId, request.user.userId)))
      .orderBy(desc(conversations.updatedAt)).limit(50);
    return { code: "OK", data: list };
  });

  // 创建新对话
  app.post("/conversations", async (request, reply) => {
    const body = createConversationSchema.parse(request.body);
    const [conv] = await db.insert(conversations).values({
      tenantId: request.tenantId, userId: request.user.userId,
      title: body.title || "新对话", skillType: body.skillType,
    }).returning();
    return reply.code(201).send({ code: "OK", data: conv });
  });

  // 获取消息历史
  app.get("/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const msgs = await db.select().from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.tenantId, request.tenantId)))
      .orderBy(messages.createdAt);
    return { code: "OK", data: msgs };
  });

  // 发送消息并获取 AI 回复
  app.post("/conversations/:id/send", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = sendMessageSchema.parse(request.body);

    // 验证对话归属
    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.tenantId, request.tenantId))).limit(1);
    if (!conv) return reply.code(404).send({ code: "NOT_FOUND", message: "对话不存在" });

    // 存储用户消息
    const [userMsg] = await db.insert(messages).values({
      tenantId: request.tenantId, conversationId: id, role: "user", content: body.content,
    }).returning();

    // 获取历史消息（用于上下文）
    const history = await db.select().from(messages)
      .where(eq(messages.conversationId, id)).orderBy(messages.createdAt).limit(20);

    let aiContent: string;
    let modelUsed = "none";
    let inputTokens = 0;
    let outputTokens = 0;

    const skill = conv.skillType ? SkillRegistry.get(conv.skillType) : null;

    if (skill) {
      // ===== 走 Skill 统一路径 =====
      const provider = getProvider(skill.preferredTier) || getProvider("cheap");
      if (!provider) {
        aiContent = "⚠️ 当前没有可用的AI模型，请在 .env 中配置 API Key。";
      } else {
        try {
          const chatHistory = history.map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: m.content,
          }));

          const result = await skill.handle(body.content, chatHistory, {
            tenantId: request.tenantId,
            userId: request.user.userId,
            conversationId: id,
            provider,
          });

          aiContent = result.reply;
          modelUsed = provider.name;

          // 如果产出了制品（文章等），保存到 contents 表
          if (result.artifact) {
            await db.insert(contents).values({
              tenantId: request.tenantId, userId: request.user.userId,
              conversationId: id, type: result.artifact.type,
              title: result.artifact.title, body: result.artifact.body,
              status: "draft",
              metadata: result.artifact.metadata || {},
            });
          }
        } catch (err) {
          logger.error({ err }, "Skill 调用失败");
          aiContent = `⚠️ AI 生成遇到问题: ${err instanceof Error ? err.message : "未知错误"}。请稍后重试。`;
        }
      }
    } else {
      // ===== 通用聊天路径（无特定技能） =====
      const provider = getProvider("cheap");
      if (!provider) {
        aiContent = "⚠️ 当前没有可用的AI模型，请在 .env 中配置 API Key。";
      } else {
        try {
          const chatMessages = history.slice(-10).map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: m.content,
          }));

          const result = await provider.chat({
            messages: [
              { role: "system", content: "你是BossMate AI超级员工，帮助老板处理各种工作任务。回答要简洁专业。" },
              ...chatMessages,
            ],
            maxTokens: 2048,
          });

          aiContent = result.content;
          modelUsed = result.model;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
        } catch (err) {
          logger.error({ err }, "AI 调用失败");
          aiContent = `⚠️ AI 暂时无法响应: ${err instanceof Error ? err.message : "未知错误"}`;
        }
      }
    }

    // 存储 AI 回复
    const [aiMsg] = await db.insert(messages).values({
      tenantId: request.tenantId, conversationId: id, role: "assistant",
      content: aiContent, model: modelUsed, tokensUsed: inputTokens + outputTokens,
    }).returning();

    // 记录 Token 使用
    if (inputTokens + outputTokens > 0) {
      await db.insert(tokenLogs).values({
        tenantId: request.tenantId, userId: request.user.userId,
        model: modelUsed, inputTokens, outputTokens,
        skillType: conv.skillType || "general",
      });
    }

    // 更新对话时间
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));

    return { code: "OK", data: { userMessage: userMsg, aiMessage: aiMsg } };
  });

  // GET /skills — 返回可用技能列表
  app.get("/skills", async () => {
    return { code: "OK", data: SkillRegistry.list() };
  });
}
