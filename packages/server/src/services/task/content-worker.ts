import { Worker, Job } from "bullmq";
import { getRedisConnection } from "./queue.js";
import { SkillRegistry } from "../skills/index.js";
import { getProvider } from "../ai/provider-factory.js";
import { db } from "../../models/db.js";
import { tasks, taskLogs, contents, scheduledPublishes, tenants, dailyContentPlans, users } from "../../models/schema.js";
import { and } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "../../config/logger.js";

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

  const result = await skill.handle(
    userInput,
    history as Array<{ role: "user" | "assistant" | "system"; content: string }>,
    { tenantId, userId, conversationId, provider }
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
      status: "draft",
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
  if (agentMeta?.planId && taskId) {
    await updatePlanTaskStatus(agentMeta.planId, taskId, "running");
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
  const result = await skill.handle(
    enrichedInput,
    history as Array<{ role: "user" | "assistant" | "system"; content: string }>,
    {
      tenantId,
      userId: ownerUserId,
      conversationId: agentMeta?.planId || nanoid(),
      provider,
    }
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
      status: "draft",
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
  }

  await job.updateProgress(90);

  // 4. Decide next action based on automationConfig.stage
  const stage = agentMeta?.automationStage || "learning";
  const qualityScore = (result as any).qualityScore || 70;
  const threshold = 75;

  if (contentId) {
    switch (stage) {
      case "full_auto":
        // Directly schedule publish
        await schedulePublish({
          tenantId,
          contentId,
          platform: agentMeta?.platform || "wechat",
          accountId: agentMeta?.accountId || "default",
          scheduledAt: agentMeta?.scheduledPublishAt || new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
        // Mark content as approved
        await db.update(contents).set({ status: "approved", updatedAt: new Date() }).where(eq(contents.id, contentId));
        break;

      case "semi_auto":
        if (qualityScore >= threshold) {
          await schedulePublish({
            tenantId,
            contentId,
            platform: agentMeta?.platform || "wechat",
            accountId: agentMeta?.accountId || "default",
            scheduledAt: agentMeta?.scheduledPublishAt || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
          await db.update(contents).set({ status: "approved", updatedAt: new Date() }).where(eq(contents.id, contentId));
        } else {
          // Needs boss review
          await db.update(contents).set({ status: "reviewing", updatedAt: new Date() }).where(eq(contents.id, contentId));
        }
        break;

      case "learning":
      default:
        // Always pending review
        await db.update(contents).set({ status: "reviewing", updatedAt: new Date() }).where(eq(contents.id, contentId));
        break;
    }
  }

  // 更新 plan 中该 task 的状态为 completed
  if (agentMeta?.planId && taskId) {
    await updatePlanTaskStatus(agentMeta.planId, taskId, "completed");
  }

  await job.updateProgress(100);

  logger.info(
    { tenantId, contentId, stage, platform: agentMeta?.platform },
    "article-write completed"
  );

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
  newStatus: string
): Promise<void> {
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

    const allDone = updated.every((t) => t.status === "completed" || t.status === "failed");
    const planStatus = allDone ? "completed" : "executing";

    await db
      .update(dailyContentPlans)
      .set({ tasks: updated, status: planStatus, updatedAt: new Date() })
      .where(eq(dailyContentPlans.id, planId));
  } catch (err) {
    logger.error({ planId, taskId, err }, "更新 plan task 状态失败");
  }
}

// ============ schedulePublish helper ============

async function schedulePublish(params: {
  tenantId: string;
  contentId: string;
  platform: string;
  accountId: string;
  scheduledAt: string;
}): Promise<void> {
  const id = nanoid(16);
  await db.insert(scheduledPublishes).values({
    id,
    tenantId: params.tenantId,
    contentId: params.contentId,
    platform: params.platform,
    accountId: params.accountId,
    scheduledAt: new Date(params.scheduledAt),
    status: "pending",
    createdAt: new Date(),
  });

  logger.info(
    { id, contentId: params.contentId, platform: params.platform, scheduledAt: params.scheduledAt },
    "Publish scheduled"
  );
}
