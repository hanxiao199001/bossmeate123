import { Worker, Job } from "bullmq";
import { getRedisConnection } from "./queue.js";
import { SkillRegistry } from "../skills/index.js";
import { runWithLlmCallAttribution } from "../billing/llm-cost.js";
import { getProvider } from "../ai/provider-factory.js";
import { db } from "../../models/db.js";
// PR P1（5-9 砍定时发布）：scheduledPublishes 已删
import { tasks, taskLogs, contents, tenants, dailyContentPlans, users, productionRecords } from "../../models/schema.js";
import { and } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "../../config/logger.js";
import { sinkGeneratedContent } from "../data-collection/crawl-data-sink.js";
import {
  initialStatusFields,
  transitionToStatus,
  InvalidTransitionError,
} from "../articles/state-machine.js";

/** P0-A2 helper：异步 worker 接入状态机时容错（lifecycle 完整性留 P0 verify，业务流程不阻塞）。 */
async function safeTransitToGenerated(contentId: string): Promise<void> {
  try {
    await transitionToStatus(contentId, "generated");
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      logger.warn({ contentId, err: err.message }, "P0 worker→generated 转移失败（非阻塞）");
    } else {
      throw err;
    }
  }
}

interface ContentJobData {
  taskId: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  skillType: string;
  userInput: string;
  history: Array<{ role: string; content: string }>;
  agentMeta?: {
    planId?: string;
    platform?: string;
    style?: string;
    wordCount?: number;
    audience?: string;
    automationStage?: string;
    scheduledPublishAt?: string;
    accountId?: string;
  };
}

export function startContentWorker(): Worker {
  const worker = new Worker<ContentJobData>(
    "content-generation",
    async (job: Job<ContentJobData>) => {
      // Route to article-write handler if job name matches
      if (job.name === "article-write") {
        return handleArticleWrite(job);
      }
      return handleDefaultContent(job);
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(`Task completed: ${job.id}`);
  });

  worker.on("failed", async (job, err) => {
    console.error(`Task failed: ${job?.id}`, err.message);
    if (job) {
      const { taskId, agentMeta } = job.data;

      // article-write 的 taskId 是 nanoid（在 plan JSON 中），不在 tasks 表
      if (job.name === "article-write") {
        if (agentMeta?.planId && taskId) {
          await updatePlanTaskStatus(agentMeta.planId, taskId, "failed");
        }
      } else {
        // 普通任务的 taskId 是 UUID，在 tasks 表中
        await db.update(tasks).set({
          status: "failed", error: err.message, updatedAt: new Date(),
        }).where(eq(tasks.id, taskId));
      }
    }
  });

  console.log("Content generation worker started (concurrency: 3)");
  return worker;
}

// ============ 默认内容生成处理（原有逻辑）============

async function handleDefaultContent(job: Job<ContentJobData>) {
  const { taskId, tenantId, userId, conversationId, skillType, userInput, history } = job.data;

  await db.update(tasks).set({
    status: "running", startedAt: new Date(), updatedAt: new Date(),
  }).where(eq(tasks.id, taskId));

  const skill = SkillRegistry.get(skillType);
  if (!skill) throw new Error(`Skill "${skillType}" not found in registry`);

  const provider = getProvider(skill.preferredTier) || getProvider("cheap");
  if (!provider) throw new Error("No AI provider available");

  await job.updateProgress(10);
  await db.update(tasks).set({ progress: 10, updatedAt: new Date() }).where(eq(tasks.id, taskId));

  const stepStart = Date.now();

  // 7-06 成本归属: skills 用单例 RoutedProvider(实例无租户), ALS 把本次任务租户带给 chat() 记账
  const result = await runWithLlmCallAttribution({ tenantId, userId, conversationId }, () =>
    skill.handle(
      userInput,
      history as Array<{ role: "user" | "assistant" | "system"; content: string }>,
      { tenantId, userId, conversationId, provider }
    )
  );

  await job.updateProgress(90);
  await db.update(tasks).set({ progress: 90, updatedAt: new Date() }).where(eq(tasks.id, taskId));

  await db.insert(taskLogs).values({
    taskId,
    step: "skill_handle",
    status: "completed",
    model: provider.name,
    durationMs: Date.now() - stepStart,
    detail: { hasArtifact: !!result.artifact, tokenUsage: result.tokenUsage },
  });

  if (result.artifact) {
    await db.insert(contents).values({
      tenantId, userId, conversationId,
      type: result.artifact.type,
      title: result.artifact.title,
      body: result.artifact.body,
      // P0-A2：异步 worker 路径同 chat.ts，AI 已生成 → 'generated'
      ...initialStatusFields(result.artifact.type === "article" ? "generated" : "draft"),
      metadata: result.artifact.metadata || {},
    });
  }

  await db.update(tasks).set({
    status: "completed", progress: 100,
    output: { reply: result.reply, artifact: result.artifact },
    completedAt: new Date(), updatedAt: new Date(),
  }).where(eq(tasks.id, taskId));

  return { reply: result.reply, hasArtifact: !!result.artifact };
}

// ============ article-write 处理（Agent 自动写作）============

async function handleArticleWrite(job: Job<ContentJobData>) {
  const { taskId, tenantId, userInput, history, agentMeta } = job.data;

  // 更新 plan 中该 task 的状态（plan tasks 是 JSON，不在 tasks 表中）
  // 使用 "writing" 与 Dashboard 前端状态名对齐
  if (agentMeta?.planId && taskId) {
    await updatePlanTaskStatus(agentMeta.planId, taskId, "writing");
  }

  // 查找 tenant owner 的 userId（contents 表需要 UUID 类型的 userId）
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "owner")))
    .limit(1);
  const ownerUserId = owner?.id || tenantId; // fallback to tenantId

  const skill = SkillRegistry.get("article");
  if (!skill) throw new Error('ArticleSkill not registered');

  const provider = getProvider(skill.preferredTier) || getProvider("cheap");
  if (!provider) throw new Error("No AI provider available");

  await job.updateProgress(10);

  const stepStart = Date.now();

  // 1. Construct enriched instruction
  const enrichedInput = userInput;

  // 2. Call ArticleSkill.handle()
  const skillConversationId = agentMeta?.planId || nanoid();
  // 7-06 成本归属(同 handleDefaultContent)
  const result = await runWithLlmCallAttribution({ tenantId, userId: ownerUserId, conversationId: skillConversationId }, () =>
    skill.handle(
      enrichedInput,
      history as Array<{ role: "user" | "assistant" | "system"; content: string }>,
      {
        tenantId,
        userId: ownerUserId,
        conversationId: skillConversationId,
        provider,
      }
    )
  );

  await job.updateProgress(70);

  // 3. Save content to DB
  let contentId: string | null = null;
  if (result.artifact) {
    const [inserted] = await db.insert(contents).values({
      tenantId,
      userId: ownerUserId,
      type: result.artifact.type,
      title: result.artifact.title,
      body: result.artifact.body,
      // P0-A2：agent worker 路径，AI 已生成 → 'generated'
      ...initialStatusFields(result.artifact.type === "article" ? "generated" : "draft"),
      metadata: {
        ...(result.artifact.metadata || {}),
        agentGenerated: true,
        platform: agentMeta?.platform,
        style: agentMeta?.style,
        wordCount: agentMeta?.wordCount,
        planId: agentMeta?.planId,
      },
    }).returning({ id: contents.id });
    contentId = inserted?.id || null;

    // T4-1b: 主版本写 productionRecords（parentId=null 标识为原稿）
    // 之前 handleArticleWrite 没写 productionRecords，借多版本一并补齐
    const totalVariants = (result.extraArtifacts?.length ?? 0) + 1;
    if (contentId) {
      try {
        await db.insert(productionRecords).values({
          tenantId,
          contentId,
          parentId: null,
          format: "long_article",
          platform: agentMeta?.platform || null,
          title: result.artifact.title,
          body: result.artifact.body,
          wordCount: (result.artifact.metadata?.wordCount as number) || result.artifact.body.length,
          status: "draft",
          producedBy: "ai",
          metadata: {
            variantIndex: 0,
            totalVariants,
            planId: agentMeta?.planId,
          },
        });
      } catch (err) {
        logger.warn({ err, contentId }, "T4-1b: 主版本 productionRecord 写入失败（非阻塞）");
      }
    }

    // T4-1b: 副版本逐个写 contents + productionRecords（parentId 串联到主版本）
    if (contentId && result.extraArtifacts && result.extraArtifacts.length > 0) {
      for (let i = 0; i < result.extraArtifacts.length; i++) {
        const extra = result.extraArtifacts[i];
        try {
          const [insertedExtra] = await db.insert(contents).values({
            tenantId,
            userId: ownerUserId,
            type: extra.type,
            title: extra.title,
            body: extra.body,
            // P0-A2：agent 副版本同样 onGenerateSuccess
            ...initialStatusFields(extra.type === "article" ? "generated" : "draft"),
            metadata: {
              ...(extra.metadata || {}),
              agentGenerated: true,
              platform: agentMeta?.platform,
              style: agentMeta?.style,
              wordCount: agentMeta?.wordCount,
              planId: agentMeta?.planId,
              variantOf: contentId,
            },
          }).returning({ id: contents.id });

          if (insertedExtra) {
            await db.insert(productionRecords).values({
              tenantId,
              contentId: insertedExtra.id,
              parentId: contentId,
              format: "long_article",
              platform: agentMeta?.platform || null,
              title: extra.title,
              body: extra.body,
              wordCount: (extra.metadata?.wordCount as number) || extra.body.length,
              status: "draft",
              producedBy: "ai",
              metadata: {
                variantIndex: (extra.metadata?.variantIndex as number) || (i + 1),
                totalVariants,
                planId: agentMeta?.planId,
              },
            });
          }
        } catch (err) {
          logger.warn(
            { err, primaryContentId: contentId, variantIndex: i + 1 },
            "T4-1b: 副版本写入失败（非阻塞）"
          );
        }
      }
      logger.info(
        { tenantId, primaryContentId: contentId, secondaryCount: result.extraArtifacts.length },
        "T4-1b: secondary variants saved"
      );
    }
  }

  await job.updateProgress(90);

  // 4. Decide next action based on automationConfig.stage
  const stage = agentMeta?.automationStage || "learning";
  const qualityScore = (result as any).qualityScore || 70;
  const threshold = 75;

  if (contentId) {
    switch (stage) {
      case "full_auto":
        // PR P1（5-9 砍定时发布）：原 schedulePublish 已删，full_auto 直接转 generated 等用户手动一键发布
        await safeTransitToGenerated(contentId);
        break;

      case "semi_auto":
        if (qualityScore >= threshold) {
          // PR P1：原 schedulePublish 已删
          await safeTransitToGenerated(contentId);
        } else {
          // Needs boss review → 'generated'（spec 删 reviewing；boss 审核状态用 metadata 记，不占状态机槽位）
          await safeTransitToGenerated(contentId);
        }
        break;

      case "learning":
      default:
        // Always pending review → 'generated'（同上，原 reviewing 映射 generated）
        await safeTransitToGenerated(contentId);
        break;
    }
  }

  // 写入 taskLogs，记录写作详情
  try {
    await db.insert(taskLogs).values({
      taskId: taskId || nanoid(),
      step: "article_write",
      status: "completed",
      model: provider.name,
      durationMs: Date.now() - stepStart,
      detail: { contentId, hasArtifact: !!result.artifact, qualityScore, stage, platform: agentMeta?.platform },
    });
  } catch (logErr) {
    logger.warn({ taskId, logErr }, "写入 taskLogs 失败（非阻塞）");
  }

  // 更新 plan 中该 task 的状态，与 Dashboard 前端状态名对齐
  if (agentMeta?.planId && taskId) {
    // learning 阶段 → "review"（待审核），full_auto/semi_auto 高分 → "published"
    const planTaskStatus = (stage === "learning" || (stage === "semi_auto" && qualityScore < threshold))
      ? "review"
      : "published";
    await updatePlanTaskStatus(agentMeta.planId, taskId, planTaskStatus);
  }

  await job.updateProgress(100);

  logger.info(
    { tenantId, contentId, stage, platform: agentMeta?.platform },
    "article-write completed"
  );

  // ===== 钩子3：高质量文章 → 知识库沉淀（异步，非阻塞）=====
  if (contentId && result.artifact) {
    sinkGeneratedContent(
      {
        contentId,
        title: result.artifact.title || "",
        body: result.artifact.body || "",
        platform: agentMeta?.platform || "unknown",
        qualityScore,
        style: agentMeta?.style,
        audience: agentMeta?.audience,
        planId: agentMeta?.planId,
      },
      tenantId
    ).catch((err) => {
      logger.warn({ contentId, err }, "钩子3: 文章沉淀失败（非阻塞）");
    });
  }

  return {
    contentId,
    hasArtifact: !!result.artifact,
    stage,
    qualityScore,
  };
}

// ============ updatePlanTaskStatus helper ============

async function updatePlanTaskStatus(
  planId: string,
  taskId: string,
  newStatus: string,
  retries = 2
): Promise<void> {
  // NOTE: read-modify-write 在并发 worker 同时完成时可能竞态，
  // 通过重试缓解（后续可升级为 PostgreSQL jsonb_set 原子更新）
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const [plan] = await db
        .select()
        .from(dailyContentPlans)
        .where(eq(dailyContentPlans.id, planId))
        .limit(1);

      if (!plan) return;

      const planTasks = (plan.tasks || []) as any[];
      const updated = planTasks.map((t) =>
        t.id === taskId ? { ...t, status: newStatus } : t
      );

      // 终态：review(待审核)、approved(已审批)、published(已发布)、failed(失败)
      const DONE_STATUSES = ["review", "approved", "published", "failed"];
      const allDone = updated.every((t) => DONE_STATUSES.includes(t.status));
      const planStatus = allDone ? "completed" : "executing";

      await db
        .update(dailyContentPlans)
        .set({ tasks: updated, status: planStatus, updatedAt: new Date() })
        .where(eq(dailyContentPlans.id, planId));

      return; // 成功，退出
    } catch (err) {
      if (attempt === retries) {
        logger.error({ planId, taskId, err }, "更新 plan task 状态失败（已重试）");
      } else {
        // 短暂延迟后重试，缓解竞态
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  }
}

// PR P1（5-9 砍定时发布）：schedulePublish helper + scheduledPublishes 表已删除。
// 用户改为审核通过后手动一键发布（走 publisher.publishToAccounts）。
