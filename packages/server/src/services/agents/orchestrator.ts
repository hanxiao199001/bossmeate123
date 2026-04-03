/**
 * Orchestrator Agent
 *
 * 总指挥：协调知识引擎 + 内容总监，驱动每日内容生产
 * 1. 调用 KnowledgeEngine
 * 2. 调用 ContentDirector
 * 3. 读取今日计划
 * 4. 按配置阶段将文章任务加入 contentQueue
 * 5. 更新计划状态
 */

import { db } from "../../models/db.js";
import { dailyContentPlans, tenants } from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { contentQueue } from "../task/queue.js";
import { logAgentAction, updateAgentLog } from "./base/agent-logger.js";
import { agentRegistry } from "./base/registry.js";
import type { ContentTask } from "./content-director.js";
import type {
  IAgent,
  AgentConfig,
  AgentContext,
  AgentResult,
  AgentStatus,
  AgentTask,
  AgentTaskResult,
} from "./base/types.js";

export class Orchestrator implements IAgent {
  readonly name = "orchestrator";
  readonly displayName = "Orchestrator";

  private status: AgentStatus = "idle";
  private config: AgentConfig = { concurrency: 1, maxRetries: 3, timeoutMs: 600_000 };

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    this.status = "idle";
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  async shutdown(): Promise<void> {
    this.status = "shutdown";
  }

  async handleTask(task: AgentTask): Promise<AgentTaskResult> {
    const start = Date.now();
    try {
      const ctx: AgentContext = {
        tenantId: task.input.tenantId as string,
        date: new Date().toISOString().slice(0, 10),
        triggeredBy: "manual",
      };
      const result = await this.execute(ctx);
      return {
        taskId: task.id,
        success: result.success,
        output: result,
        metrics: { durationMs: Date.now() - start, tokensUsed: 0 },
      };
    } catch (err: any) {
      return {
        taskId: task.id,
        success: false,
        error: err.message,
        metrics: { durationMs: Date.now() - start, tokensUsed: 0 },
      };
    }
  }

  async execute(context: AgentContext): Promise<AgentResult> {
    const start = Date.now();
    this.status = "running";

    const logId = await logAgentAction({
      tenantId: context.tenantId,
      agentName: this.name,
      action: "daily_orchestrate",
      status: "running",
      input: { date: context.date, triggeredBy: context.triggeredBy },
    });

    const details: unknown[] = [];
    let tasksCompleted = 0;
    let tasksFailed = 0;

    // Step 1: Call KnowledgeEngine
    const knowledgeEngine = agentRegistry.get("knowledge-engine");
    if (knowledgeEngine) {
      try {
        const keResult = await knowledgeEngine.execute(context);
        details.push({ step: "knowledge-engine", ...keResult });
        if (keResult.success) tasksCompleted++;
        else tasksFailed++;
      } catch (err: any) {
        logger.error({ err }, "KnowledgeEngine execution failed in orchestrator");
        details.push({ step: "knowledge-engine", error: err.message });
        tasksFailed++;
      }
    } else {
      logger.warn("KnowledgeEngine not registered, skipping");
      details.push({ step: "knowledge-engine", skipped: true });
    }

    // Step 2: Call ContentDirector
    const contentDirector = agentRegistry.get("content-director");
    if (contentDirector) {
      try {
        const cdResult = await contentDirector.execute(context);
        details.push({ step: "content-director", ...cdResult });
        if (cdResult.success) tasksCompleted++;
        else tasksFailed++;
      } catch (err: any) {
        logger.error({ err }, "ContentDirector execution failed in orchestrator");
        details.push({ step: "content-director", error: err.message });
        tasksFailed++;
      }
    } else {
      logger.warn("ContentDirector not registered, skipping");
      details.push({ step: "content-director", skipped: true });
    }

    // Step 3: Read today's plan
    const [plan] = await db
      .select()
      .from(dailyContentPlans)
      .where(
        and(
          eq(dailyContentPlans.tenantId, context.tenantId),
          eq(dailyContentPlans.date, context.date)
        )
      )
      .limit(1);

    if (!plan) {
      const durationMs = Date.now() - start;
      await updateAgentLog(logId, { status: "completed", output: { details, note: "no plan found" }, durationMs });
      this.status = "idle";
      return {
        agentName: this.name,
        success: false,
        tasksCompleted,
        tasksFailed: tasksFailed + 1,
        summary: "No daily plan found after ContentDirector execution",
        details,
        durationMs,
      };
    }

    // Step 4: Read tenant automationConfig.stage
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, context.tenantId))
      .limit(1);

    const tenantConfig = (tenant?.config || {}) as Record<string, any>;
    const automationConfig = tenantConfig.automationConfig || {};
    const stage = automationConfig.stage || "learning"; // learning | semi_auto | full_auto

    // Step 5: Add article tasks to contentQueue
    const planTasks = (plan.tasks || []) as ContentTask[];
    let queued = 0;

    for (const task of planTasks) {
      if (task.type !== "article") continue;

      const delay = calculateDelay(task.scheduledPublishAt);

      await contentQueue.add(
        "article-write",
        {
          taskId: task.id,
          tenantId: context.tenantId,
          userId: "system",
          conversationId: `auto-${task.id}`,
          skillType: "article",
          userInput: buildArticleInstruction(task),
          history: [],
          agentMeta: {
            planId: plan.id,
            platform: task.platform,
            style: task.style,
            wordCount: task.wordCount,
            audience: task.audience,
            automationStage: stage,
            scheduledPublishAt: task.scheduledPublishAt,
            accountId: task.accountId,
          },
        },
        {
          delay: Math.max(delay, 0),
          priority: task.priority === "urgent" ? 1 : task.priority === "high" ? 2 : 3,
          jobId: `article-${context.date}-${task.id}`,
        }
      );
      queued++;
    }

    // Step 6: Update plan status
    await db
      .update(dailyContentPlans)
      .set({ status: "executing", updatedAt: new Date() })
      .where(eq(dailyContentPlans.id, plan.id));

    tasksCompleted++;

    const durationMs = Date.now() - start;
    await updateAgentLog(logId, {
      status: "completed",
      output: { planId: plan.id, queued, stage },
      durationMs,
    });

    this.status = "idle";
    return {
      agentName: this.name,
      success: true,
      tasksCompleted,
      tasksFailed,
      summary: `Orchestrator: ${queued} tasks queued (stage=${stage})`,
      details: [...details, { step: "queue", queued, stage, planId: plan.id }],
      durationMs,
    };
  }
}

// ============ Helpers ============

function buildArticleInstruction(task: ContentTask): string {
  const parts = [
    `请撰写一篇关于"${task.topic}"的文章。`,
    `目标平台: ${task.platform}`,
    `写作风格: ${task.style}`,
    `目标字数: ${task.wordCount}字`,
    `目标受众: ${task.audience}`,
  ];
  if (task.referenceJournals.length > 0) {
    parts.push(`参考期刊: ${task.referenceJournals.join("、")}`);
  }
  return parts.join("\n");
}

function calculateDelay(scheduledTime: string): number {
  if (!scheduledTime) return 0;
  const scheduled = new Date(scheduledTime).getTime();
  const now = Date.now();
  // 提前30分钟开始生成，给写作留出时间
  return Math.max(scheduled - now - 30 * 60 * 1000, 0);
}

/**
 * 获取租户每日进度
 */
export async function getDailyProgress(tenantId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const [plan] = await db
    .select()
    .from(dailyContentPlans)
    .where(
      and(
        eq(dailyContentPlans.tenantId, tenantId),
        eq(dailyContentPlans.date, today)
      )
    )
    .limit(1);

  if (!plan) {
    return { date: today, hasPlan: false, tasks: [], status: "no_plan" };
  }

  const tasks = (plan.tasks || []) as ContentTask[];
  const statusCounts: Record<string, number> = {};
  for (const t of tasks) {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
  }

  return {
    date: today,
    hasPlan: true,
    planId: plan.id,
    totalArticles: plan.totalArticles,
    totalVideos: plan.totalVideos,
    planStatus: plan.status,
    taskStatusCounts: statusCounts,
    tasks: tasks.map((t) => ({
      id: t.id,
      topic: t.topic,
      platform: t.platform,
      status: t.status,
      scheduledPublishAt: t.scheduledPublishAt,
    })),
  };
}
