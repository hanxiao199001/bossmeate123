/**
 * 对话路由 - 集成图文线 Skill、AI 调用、一句话发布
 *
 * V4: 智能 skill 路由 + 进度展示
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, inArray, lt } from "drizzle-orm";
import { db } from "../models/db.js";
import { conversations, messages, contents, tokenLogs, platformAccounts, productionRecords } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { getProvider } from "../services/ai/provider-factory.js";
import { SkillRegistry } from "../services/skills/index.js";
import { publishToAccounts } from "../services/publisher/index.js";

const createConversationSchema = z.object({
  title: z.string().optional(),
  skillType: z.enum(["article", "video", "customer_service", "general", "daily_chat"]).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1, "消息不能为空"),
  // T4-1c-1: 多版本生成参数（默认 1，向后兼容）
  variants: z.number().int().min(1).max(3).optional(),
});

// 发布指令关键词
const PUBLISH_KEYWORDS = ["发布", "可以发了", "发到", "推送", "发出去", "发吧", "发送"];

// 平台名称映射
const PLATFORM_MAP: Record<string, string> = {
  "微信": "wechat", "公众号": "wechat",
  "百家号": "baijiahao", "百家": "baijiahao",
  "头条": "toutiao", "今日头条": "toutiao",
  "知乎": "zhihu",
  "小红书": "xiaohongshu", "红书": "xiaohongshu",
  "所有": "all", "全部": "all", "全平台": "all",
};

// 智能判断是否应该走 article skill（当 skillType 未指定或为 general 时）
function shouldUseArticleSkill(message: string): boolean {
  const patterns = [
    /写.{0,5}(文章|图文|内容|科普|分析|报告)/,
    /生成.{0,5}(文章|图文|内容)/,
    /创作/,
    /帮我写/,
    /一篇/,
    /发(到|布).{0,5}(微信|公众号|知乎|头条|百家|小红书)/,
    /关于.{2,20}(的|写|发)/,
  ];
  return patterns.some((p) => p.test(message));
}

export async function chatRoutes(app: FastifyInstance) {
  // 获取对话列表
  app.get("/conversations", async (request, reply) => {
    try {
      const list = await db.select().from(conversations)
        .where(and(eq(conversations.tenantId, request.tenantId), eq(conversations.userId, request.user.userId)))
        .orderBy(desc(conversations.updatedAt)).limit(50);
      return { code: "OK", data: list };
    } catch (err) {
      logger.error({ err }, "获取对话列表失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  // 创建新对话
  app.post("/conversations", async (request, reply) => {
    try {
      const body = createConversationSchema.parse(request.body);
      const skillType = body.skillType === "general" ? null : (body.skillType || null);
      const [conv] = await db.insert(conversations).values({
        tenantId: request.tenantId, userId: request.user.userId,
        title: body.title || "新对话", skillType,
      }).returning();
      return reply.code(201).send({ code: "OK", data: conv });
    } catch (err) {
      logger.error({ err }, "创建对话失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  // 获取消息历史（支持分页）
  app.get("/conversations/:id/messages", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as {
        limit?: string;
        before?: string;
      };

      const limit = Math.min(100, Math.max(1, parseInt(query.limit || "50", 10)));
      const before = query.before; // 游标，如果存在则获取比这个消息更早的消息

      const conditions = [
        eq(messages.conversationId, id),
        eq(messages.tenantId, request.tenantId),
      ];

      // 如果有游标，获取该消息之前的消息
      if (before) {
        const [beforeMsg] = await db.select()
          .from(messages)
          .where(eq(messages.id, before))
          .limit(1);

        if (beforeMsg) {
          // 获取创建时间比 before 消息更早的消息
          conditions.push(lt(messages.createdAt, beforeMsg.createdAt));
        }
      }

      const msgs = await db.select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1); // 多取一条来判断是否还有更多

      // 反转顺序，返回时间正序
      const items = msgs.reverse();
      const hasMore = msgs.length > limit;
      const data = items.slice(0, limit);

      return {
        code: "OK",
        data: {
          items: data,
          hasMore,
          oldestId: data.length > 0 ? data[0].id : undefined,
        },
      };
    } catch (err) {
      logger.error({ err }, "获取消息历史失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  // 发送消息并获取 AI 回复
  app.post("/conversations/:id/send", async (request, reply) => {
    try {
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

      // 检测"后续说发布"场景
      const isPublishCommand = PUBLISH_KEYWORDS.some((k) => userMessage.includes(k));
      if (isPublishCommand) {
        const publishReply = await handlePublishCommand(userMessage, id, request.tenantId);
        if (publishReply) {
          const [aiMsg] = await db.insert(messages).values({
            tenantId: request.tenantId, conversationId: id, role: "assistant",
            content: publishReply, model: "system",
          }).returning();
          await db.update(conversations).set({ updatedAt: new Date() }).where(and(eq(conversations.id, id), eq(conversations.tenantId, request.tenantId)));
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

      // V4: 智能 skill 路由
      // 1. 对话已绑定 skillType → 直接用
      // 2. 对话没绑定 → 根据用户消息智能判断
      let skill = conv.skillType ? SkillRegistry.get(conv.skillType) : null;

      if (!skill && shouldUseArticleSkill(userMessage)) {
        skill = SkillRegistry.get("article");
        // 更新对话的 skillType，后续消息不用再判断
        if (skill) {
          await db.update(conversations)
            .set({ skillType: "article" })
            .where(and(eq(conversations.id, id), eq(conversations.tenantId, request.tenantId)));
          logger.info({ conversationId: id }, "智能路由：识别为图文创作，切换到 ArticleSkill");
        }
      }

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

            // 先调用 skill.handle，不预创建 content（避免追问阶段创建空记录）
            const result = await skill.handle(body.content, chatHistory, {
              tenantId: request.tenantId,
              userId: request.user.userId,
              conversationId: id,
              provider,
              metadata: {
                // T4-1c-1: 把 body.variants 透传给 ArticleSkill（默认 1）
                variants: body.variants ?? 1,
              },
            });

            // 只有产出制品时才写入 contents 表
            if (result.artifact) {
              const [contentRow] = await db.insert(contents).values({
                tenantId: request.tenantId,
                userId: request.user.userId,
                conversationId: id,
                type: result.artifact.type,
                title: result.artifact.title,
                body: result.artifact.body,
                status: "draft",
                metadata: result.artifact.metadata || {},
              }).returning();

              // T4-1c-1 commit 4: 多版本 chat 路径持久化（仅对 article 类型；
              // 与 content-worker.handleArticleWrite 行为一致，让 GET /:id siblings 能从 chat 触发的多版本里查到）
              if (contentRow && result.artifact.type === "article") {
                const primaryContentId = contentRow.id;
                const totalVariants = (result.extraArtifacts?.length ?? 0) + 1;

                // 1. 主版本 productionRecord (parentId=null) — parentId 链的起点
                try {
                  await db.insert(productionRecords).values({
                    tenantId: request.tenantId,
                    contentId: primaryContentId,
                    parentId: null,
                    format: "long_article",
                    platform: null,
                    title: result.artifact.title,
                    body: result.artifact.body,
                    wordCount:
                      (result.artifact.metadata?.wordCount as number) ||
                      result.artifact.body.length,
                    status: "draft",
                    producedBy: "ai",
                    metadata: {
                      variantIndex: 0,
                      totalVariants,
                      conversationId: id,
                    },
                  });
                } catch (err) {
                  logger.warn(
                    { err, contentId: primaryContentId },
                    "T4-1c-1: 主版本 productionRecord 写入失败（非阻塞）"
                  );
                }

                // 2. 副版本逐个写 contents + productionRecords（parentId 串联到主版本）
                if (result.extraArtifacts && result.extraArtifacts.length > 0) {
                  for (let i = 0; i < result.extraArtifacts.length; i++) {
                    const extra = result.extraArtifacts[i];
                    try {
                      const [insertedExtra] = await db
                        .insert(contents)
                        .values({
                          tenantId: request.tenantId,
                          userId: request.user.userId,
                          conversationId: id,
                          type: extra.type,
                          title: extra.title,
                          body: extra.body,
                          status: "draft",
                          metadata: {
                            ...(extra.metadata || {}),
                            variantOf: primaryContentId,
                          },
                        })
                        .returning({ id: contents.id });

                      if (insertedExtra) {
                        await db.insert(productionRecords).values({
                          tenantId: request.tenantId,
                          contentId: insertedExtra.id,
                          parentId: primaryContentId,
                          format: "long_article",
                          platform: null,
                          title: extra.title,
                          body: extra.body,
                          wordCount:
                            (extra.metadata?.wordCount as number) ||
                            extra.body.length,
                          status: "draft",
                          producedBy: "ai",
                          metadata: {
                            variantIndex:
                              (extra.metadata?.variantIndex as number) || i + 1,
                            totalVariants,
                            conversationId: id,
                          },
                        });
                      }
                    } catch (err) {
                      logger.warn(
                        { err, primaryContentId, variantIndex: i + 1 },
                        "T4-1c-1: 副版本写入失败（非阻塞）"
                      );
                    }
                  }
                  logger.info(
                    {
                      tenantId: request.tenantId,
                      primaryContentId,
                      secondaryCount: result.extraArtifacts.length,
                    },
                    "T4-1c-1: chat 路径副版本已落库"
                  );
                }
              }

              // 视频脚本 → 完全异步触发合成（setImmediate 隔离，任何失败不影响脚本回复）
              if (result.artifact.type === "video_script" && contentRow) {
                const artifactBody = result.artifact.body;
                const artifactTitle = result.artifact.title;
                const scriptContentId = contentRow.id;
                const tid = request.tenantId;
                const uid = request.user.userId;

                setImmediate(async () => {
                  try {
                    let scriptData: any;
                    try {
                      scriptData = JSON.parse(artifactBody);
                    } catch {
                      const jsonMatch = artifactBody.match(/```json\s*([\s\S]*?)```/);
                      if (jsonMatch) scriptData = JSON.parse(jsonMatch[1].trim());
                    }
                    if (!scriptData?.scenes?.length) return;

                    const { produceVideo } = await import("../services/video/index.js");
                    const videoResult = await produceVideo({
                      tenantId: tid,
                      title: scriptData.title || artifactTitle || "视频",
                      journalId: typeof scriptData.journalId === "string" ? scriptData.journalId : undefined,
                      scenes: scriptData.scenes.map((s: any) => {
                        // 兼容 AI 可能用的各种字段名
                        const rawKw = s.keywords || s.visualElements || s.visual_elements
                          || s.visuals || s.imageKeywords || s.searchTerms || [];
                        // 如果关键词为空，从 voiceoverText 提取简短关键词兜底
                        const voText = s.voiceoverText || s.narration || s.description || "";
                        const fallbackKw = voText.slice(0, 15) || "business";
                        const visualKeywords = rawKw.length > 0 ? rawKw : [fallbackKw];
                        return {
                          voiceoverText: voText,
                          visualKeywords,
                          durationMs: (s.duration || 5) * 1000,
                          subtitle: s.voiceoverText || s.description || "",
                          sceneType: s.sceneType,
                        };
                      }),
                    });

                    await db.insert(contents).values({
                      tenantId: tid,
                      userId: uid,
                      type: "video",
                      title: scriptData.title || artifactTitle || "视频",
                      body: videoResult.url,
                      status: "draft",
                      metadata: {
                        videoUrl: videoResult.url,
                        durationMs: videoResult.durationMs,
                        sizeBytes: videoResult.sizeBytes,
                        scenesCount: videoResult.scenesCount,
                        scriptContentId,
                      },
                    });
                    logger.info({ url: videoResult.url, scenes: videoResult.scenesCount }, "视频合成完成并保存");
                  } catch (err) {
                    logger.error({ err, stack: err instanceof Error ? err.stack : undefined }, "视频后台合成失败（不影响脚本回复）");
                  }
                });

                result.reply += `\n\n🎬 **视频正在后台合成中**，预计 1-3 分钟完成。\n合成完成后会自动保存到内容库。`;
              }

              // 如果 artifact 中有 publishIntent 且需要自动发布，补充 contentId 后发布
              const publishIntent = result.artifact.metadata?.publishIntent as
                { wantPublish?: boolean; platforms?: string[]; timing?: string } | undefined;

              if (
                publishIntent?.wantPublish &&
                publishIntent.timing !== "after_review" &&
                result.artifact.metadata?.qualityPassed &&
                contentRow
              ) {
                try {
                  const publishResults = await autoPublishForContent(
                    request.tenantId,
                    contentRow.id,
                    publishIntent.platforms || [],
                  );
                  // 追加发布结果到回复
                  if (publishResults.length > 0) {
                    const successList = publishResults.filter((r) => r.success);
                    const failList = publishResults.filter((r) => !r.success);
                    let publishInfo = "";
                    if (successList.length > 0) {
                      publishInfo += `\n\n已成功发布到：\n`;
                      successList.forEach((r) => {
                        publishInfo += `- ${r.accountName}（${r.platform}）${r.url ? ": " + r.url : ""}\n`;
                      });
                    }
                    if (failList.length > 0) {
                      publishInfo += `\n以下平台发布失败：\n`;
                      failList.forEach((r) => {
                        publishInfo += `- ${r.accountName}: ${r.error}\n`;
                      });
                    }
                    result.reply += publishInfo;
                  }
                } catch (err) {
                  logger.error({ err }, "自动发布失败");
                }
              }
            }

            // 构建带进度标记的回复
            aiContent = result.reply;
            if (result.artifact) {
              // 在回复前面加上流程进度
              const progressInfo = buildProgressInfo(result);
              aiContent = progressInfo + "\n\n" + result.reply;
            }

            modelUsed = provider.name;
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

      await db.update(conversations).set({ updatedAt: new Date() }).where(and(eq(conversations.id, id), eq(conversations.tenantId, request.tenantId)));

      return { code: "OK", data: { userMessage: userMsg, aiMessage: aiMsg } };
    } catch (err) {
      logger.error({ err }, "发送消息失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  // GET /skills
  app.get("/skills", async (request, reply) => {
    try {
      return { code: "OK", data: SkillRegistry.list() };
    } catch (err) {
      logger.error({ err }, "获取技能列表失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });
}

// ============ 进度信息构建 ============

function buildProgressInfo(result: { reply: string; artifact?: { metadata?: Record<string, unknown> } }): string {
  const meta = result.artifact?.metadata;
  if (!meta) return "";

  const score = meta.qualityScore as number | undefined;
  const passed = meta.qualityPassed as boolean | undefined;
  const publishResults = meta.publishResults as Array<{ success: boolean }> | undefined;

  const steps: string[] = [];
  steps.push("[1/8] 关键词搜索 ✓");
  steps.push("[2/8] 关键词聚类 ✓");
  steps.push("[3/8] 标题生成 ✓");
  steps.push("[4/8] 期刊检索 ✓");
  steps.push("[5/8] 匹配模版 ✓");
  steps.push("[6/8] AI+知识库RAG ✓");

  if (score != null) {
    steps.push(`[7/8] 质量核查 ${passed ? "✓" : "⚠"} ${score}分`);
  } else {
    steps.push("[7/8] 质量核查 ✓");
  }

  if (publishResults && publishResults.length > 0) {
    const successCount = publishResults.filter((r) => r.success).length;
    steps.push(`[8/8] 发布 ✓ ${successCount}/${publishResults.length}`);
  } else {
    steps.push("[8/8] 发布 — 待确认");
  }

  return "<!--progress:" + JSON.stringify({
    steps: steps.map((s, i) => ({
      step: i + 1,
      label: ["关键词搜索", "关键词聚类", "标题生成", "期刊检索", "匹配模版", "AI+知识库RAG", "质量核查", "发布"][i],
      status: s.includes("✓") ? "done" : s.includes("⚠") ? "warn" : "pending",
      detail: s,
    })),
    score: score ?? null,
    passed: passed ?? null,
  }) + "-->\n" + steps.join(" → ");
}

// ============ 自动发布 ============

async function autoPublishForContent(
  tenantId: string,
  contentId: string,
  platforms: string[],
) {
  const accounts = await db
    .select()
    .from(platformAccounts)
    .where(
      and(
        eq(platformAccounts.tenantId, tenantId),
        eq(platformAccounts.status, "active"),
        eq(platformAccounts.isVerified, true),
        inArray(platformAccounts.platform, platforms),
      )
    );

  if (accounts.length === 0) {
    return [{
      accountId: "", accountName: "", platform: platforms.join(","),
      success: false, error: `未找到${platforms.join("、")}平台的已验证账号`,
    }];
  }

  return publishToAccounts({
    contentId, tenantId,
    accountIds: accounts.map((a) => a.id),
  });
}

// ============ 处理"后续说发布"指令 ============

async function handlePublishCommand(
  userMessage: string,
  conversationId: string,
  tenantId: string,
): Promise<string | null> {
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
    return null;
  }

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

  try {
    const results = await publishToAccounts({
      contentId: latestContent.id,
      tenantId,
      accountIds: accounts.map((a) => a.id),
    });

    await db.update(contents).set({ status: "published", updatedAt: new Date() })
      .where(and(eq(contents.id, latestContent.id), eq(contents.tenantId, tenantId)));

    const successList = results.filter((r) => r.success);
    const failList = results.filter((r) => !r.success);

    let reply = `正在发布「${latestContent.title}」...\n\n`;
    if (successList.length > 0) {
      reply += `已成功发布到：\n`;
      successList.forEach((r) => { reply += `- ${r.accountName}（${r.platform}）${r.url ? ": " + r.url : ""}\n`; });
    }
    if (failList.length > 0) {
      reply += `\n以下平台发布失败：\n`;
      failList.forEach((r) => { reply += `- ${r.accountName}: ${r.error}\n`; });
    }
    return reply;
  } catch (err) {
    logger.error({ err, contentId: latestContent.id }, "发布指令执行失败");
    return `发布失败: ${err instanceof Error ? err.message : "未知错误"}，请稍后重试。`;
  }
}
