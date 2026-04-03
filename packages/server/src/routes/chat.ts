/**
 * 对话路由 - 集成图文线 Skill、AI 调用、一句话发布
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../models/db.js";
import { conversations, messages, contents, tokenLogs, platformAccounts } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { getProvider } from "../services/ai/provider-factory.js";
import { SkillRegistry } from "../services/skills/index.js";
import { publishToAccounts } from "../services/publisher/index.js";

const createConversationSchema = z.object({
  title: z.string().optional(),
  skillType: z.enum(["article", "video", "customer_service"]).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1, "消息不能为空"),
});

// V3: 发布指令关键词
const PUBLISH_KEYWORDS = ["发布", "可以发了", "发到", "推送", "发出去", "发吧", "发送"];

// V3: 平台名称映射
const PLATFORM_MAP: Record<string, string> = {
  "微信": "wechat", "公众号": "wechat",
  "百家号": "baijiahao", "百家": "baijiahao",
  "头条": "toutiao", "今日头条": "toutiao",
  "知乎": "zhihu",
  "小红书": "xiaohongshu", "红书": "xiaohongshu",
  "所有": "all", "全部": "all", "全平台": "all",
};

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
    const userMessage = body.content;

    // 验证对话归属
    const [conv] = await db.select().from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.tenantId, request.tenantId))).limit(1);
    if (!conv) return reply.code(404).send({ code: "NOT_FOUND", message: "对话不存在" });

    // 存储用户消息
    const [userMsg] = await db.insert(messages).values({
      tenantId: request.tenantId, conversationId: id, role: "user", content: userMessage,
    }).returning();

    // V3: 检测"后续说发布"场景
    const isPublishCommand = PUBLISH_KEYWORDS.some((k) => userMessage.includes(k));
    if (isPublishCommand && conv.skillType === "article") {
      const publishReply = await handlePublishCommand(
        userMessage,
        id,
        request.tenantId,
      );

      if (publishReply) {
        // 存储 AI 回复
        const [aiMsg] = await db.insert(messages).values({
          tenantId: request.tenantId, conversationId: id, role: "assistant",
          content: publishReply, model: "system",
        }).returning();

        await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
        return { code: "OK", data: { userMessage: userMsg, aiMessage: aiMsg } };
      }
    }

    // 获取历史消息
    const history = await db.select().from(messages)
      .where(eq(messages.conversationId, id)).orderBy(messages.createdAt).limit(20);

    let aiContent: string;
    let modelUsed = "none";
    let inputTokens = 0;
    let outputTokens = 0;

    const skill = conv.skillType ? SkillRegistry.get(conv.skillType) : null;

    if (skill) {
      const provider = getProvider(skill.preferredTier) || getProvider("cheap");
      if (!provider) {
        aiContent = "当前没有可用的AI模型，请在 .env 中配置 API Key。";
      } else {
        try {
          const chatHistory = history.map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: m.content,
          }));

          // V3: 先创建 draft content 记录，拿到 contentId 传给 Skill
          const [contentRow] = await db.insert(contents).values({
            tenantId: request.tenantId,
            userId: request.user.userId,
            conversationId: id,
            type: "article",
            title: "生成中...",
            body: "",
            status: "generating" as any,
          }).returning();

          const result = await skill.handle(body.content, chatHistory, {
            tenantId: request.tenantId,
            userId: request.user.userId,
            conversationId: id,
            provider,
            metadata: {
              contentId: contentRow.id,
            },
          });

          aiContent = result.reply;
          modelUsed = provider.name;

          // V3: 生成完成后更新 content 记录
          if (result.artifact) {
            await db.update(contents)
              .set({
                title: result.artifact.title,
                body: result.artifact.body,
                status: (result.artifact.metadata?.qualityPassed ? "draft" : "draft") as any,
                metadata: result.artifact.metadata || {},
                updatedAt: new Date(),
              })
              .where(eq(contents.id, contentRow.id));
          } else {
            // 没产出制品（比如追问阶段），删除占位记录
            await db.delete(contents).where(eq(contents.id, contentRow.id));
          }
        } catch (err) {
          logger.error({ err }, "Skill 调用失败");
          aiContent = `AI 生成遇到问题: ${err instanceof Error ? err.message : "未知错误"}。请稍后重试。`;
        }
      }
    } else {
      // 通用聊天路径
      const provider = getProvider("cheap");
      if (!provider) {
        aiContent = "当前没有可用的AI模型，请在 .env 中配置 API Key。";
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
          aiContent = `AI 暂时无法响应: ${err instanceof Error ? err.message : "未知错误"}`;
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

    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));

    return { code: "OK", data: { userMessage: userMsg, aiMessage: aiMsg } };
  });

  // GET /skills
  app.get("/skills", async () => {
    return { code: "OK", data: SkillRegistry.list() };
  });
}

// ============ V3: 处理"后续说发布"指令 ============

async function handlePublishCommand(
  userMessage: string,
  conversationId: string,
  tenantId: string,
): Promise<string | null> {
  // 找到最近的 draft 内容
  const [latestContent] = await db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.conversationId, conversationId),
        eq(contents.tenantId, tenantId),
        inArray(contents.status, ["draft", "reviewing"]),
      )
    )
    .orderBy(desc(contents.createdAt))
    .limit(1);

  if (!latestContent || !latestContent.body) {
    return null; // 没有待发布内容，走正常 Skill 流程
  }

  // 解析用户提到的平台
  const targetPlatforms: string[] = [];
  for (const [keyword, platform] of Object.entries(PLATFORM_MAP)) {
    if (userMessage.includes(keyword)) {
      if (platform === "all") {
        targetPlatforms.push("wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu");
        break;
      }
      if (!targetPlatforms.includes(platform)) {
        targetPlatforms.push(platform);
      }
    }
  }

  // 如果没指定平台，查找该租户所有已验证的账号平台
  if (targetPlatforms.length === 0) {
    const accounts = await db
      .select({ platform: platformAccounts.platform })
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.tenantId, tenantId),
          eq(platformAccounts.status, "active"),
          eq(platformAccounts.isVerified, true),
        )
      );

    if (accounts.length === 0) {
      return `当前没有已绑定的发布账号，请先在"账号管理"中绑定平台账号。`;
    }

    const uniquePlatforms = [...new Set(accounts.map((a) => a.platform))];
    targetPlatforms.push(...uniquePlatforms);
  }

  // 查找目标平台的活跃已验证账号
  const accounts = await db
    .select()
    .from(platformAccounts)
    .where(
      and(
        eq(platformAccounts.tenantId, tenantId),
        eq(platformAccounts.status, "active"),
        eq(platformAccounts.isVerified, true),
        inArray(platformAccounts.platform, targetPlatforms),
      )
    );

  if (accounts.length === 0) {
    return `未找到${targetPlatforms.join("、")}平台的已验证账号，请先在"账号管理"中绑定。`;
  }

  // 执行发布
  try {
    const results = await publishToAccounts({
      contentId: latestContent.id,
      tenantId,
      accountIds: accounts.map((a) => a.id),
    });

    // 更新内容状态
    await db
      .update(contents)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(contents.id, latestContent.id));

    // 构造回复
    const successList = results.filter((r) => r.success);
    const failList = results.filter((r) => !r.success);

    let reply = `正在发布「${latestContent.title}」...\n\n`;

    if (successList.length > 0) {
      reply += `已成功发布到：\n`;
      successList.forEach((r) => {
        reply += `- ${r.accountName}（${r.platform}）${r.url ? ": " + r.url : ""}\n`;
      });
    }
    if (failList.length > 0) {
      reply += `\n以下平台发布失败：\n`;
      failList.forEach((r) => {
        reply += `- ${r.accountName}: ${r.error}\n`;
      });
    }

    return reply;
  } catch (err) {
    logger.error({ err, contentId: latestContent.id }, "发布指令执行失败");
    return `发布失败: ${err instanceof Error ? err.message : "未知错误"}，请稍后重试。`;
  }
}
