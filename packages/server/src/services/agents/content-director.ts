/**
 * ContentDirector Agent
 *
 * 内容总监：每日生成 DailyContentPlan
 * 1. 获取选题推荐
 * 2. 获取可用平台账号
 * 3. 读取自动化配置
 * 4. 为每个 topic x platform 生成 ContentTask
 * 5. 保存到 daily_content_plans
 */

import { nanoid } from "nanoid";
import { db } from "../../models/db.js";
import {
  dailyContentPlans,
  platformAccounts,
  tenants,
} from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { generateDailyRecommendations } from "../content-engine/topic-recommender.js";
import { logAgentAction, updateAgentLog } from "./base/agent-logger.js";
import type {
  IAgent,
  AgentConfig,
  AgentContext,
  AgentResult,
  AgentStatus,
  AgentTask,
  AgentTaskResult,
} from "./base/types.js";

// ============ ContentTask / DailyContentPlan 类型 ============

export interface ContentTask {
  id: string;
  type: "article" | "video";
  topic: string;
  style: string;
  platform: string;
  accountId: string;
  wordCount: number;
  audience: string;
  referenceJournals: string[];
  scheduledPublishAt: string;
  priority: "urgent" | "high" | "normal" | "low";
  recommendationId?: string;
  status: "pending" | "writing" | "review" | "approved" | "published" | "failed";
}

export interface DailyContentPlan {
  id: string;
  tenantId: string;
  date: string;
  tasks: ContentTask[];
  totalArticles: number;
  totalVideos: number;
  status: "draft" | "approved" | "executing" | "completed";
  generatedAt: string;
}

// ============ 平台风格映射 ============

const PLATFORM_STYLE_MAP: Record<string, { style: string; wordCount: number }> = {
  wechat: { style: "deep_analysis", wordCount: 2000 },
  baijiahao: { style: "popular_science", wordCount: 1200 },
  toutiao: { style: "news_brief", wordCount: 800 },
  zhihu: { style: "qa_format", wordCount: 1500 },
  xiaohongshu: { style: "listicle", wordCount: 600 },
};

// 默认发布时间（小时:分钟）
const PLATFORM_PUBLISH_HOURS: Record<string, string> = {
  wechat: "08:30",
  baijiahao: "09:00",
  toutiao: "10:00",
  zhihu: "11:00",
  xiaohongshu: "12:00",
};

export class ContentDirector implements IAgent {
  readonly name = "content-director";
  readonly displayName = "Content Director";

  private status: AgentStatus = "idle";
  private config: AgentConfig = { concurrency: 1, maxRetries: 3, timeoutMs: 300_000 };

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
      action: "generate_daily_plan",
      status: "running",
      input: { date: context.date },
    });

    try {
      const plan = await this.generatePlan(context.tenantId, context.date, context.triggeredBy === "manual");
      const durationMs = Date.now() - start;

      await updateAgentLog(logId, {
        status: "completed",
        output: { planId: plan.id, articles: plan.totalArticles, videos: plan.totalVideos },
        durationMs,
      });

      this.status = "idle";
      return {
        agentName: this.name,
        success: true,
        tasksCompleted: 1,
        tasksFailed: 0,
        summary: `DailyContentPlan generated: ${plan.totalArticles} articles, ${plan.totalVideos} videos`,
        details: [plan],
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      await updateAgentLog(logId, { status: "failed", error: err.message, durationMs });
      this.status = "error";
      return {
        agentName: this.name,
        success: false,
        tasksCompleted: 0,
        tasksFailed: 1,
        summary: `ContentDirector failed: ${err.message}`,
        durationMs,
      };
    }
  }

  private async generatePlan(tenantId: string, date: string, forceRegenerate = false): Promise<DailyContentPlan> {
    // Check existing plan for today
    const existing = await db
      .select()
      .from(dailyContentPlans)
      .where(
        and(
          eq(dailyContentPlans.tenantId, tenantId),
          eq(dailyContentPlans.date, date)
        )
      )
      .limit(1);

    if (existing.length > 0 && !forceRegenerate) {
      logger.info({ tenantId, date }, "Daily plan already exists, returning it");
      return {
        id: existing[0].id,
        tenantId,
        date,
        tasks: existing[0].tasks as ContentTask[],
        totalArticles: existing[0].totalArticles || 0,
        totalVideos: existing[0].totalVideos || 0,
        status: (existing[0].status || "draft") as DailyContentPlan["status"],
        generatedAt: existing[0].createdAt.toISOString(),
      };
    }

    if (existing.length > 0 && forceRegenerate) {
      logger.info({ tenantId, date }, "手动触发，删除旧计划，重新生成");
      await db.delete(dailyContentPlans).where(
        and(eq(dailyContentPlans.tenantId, tenantId), eq(dailyContentPlans.date, date))
      );
    }

    // 1. Get recommendations
    const recReport = await generateDailyRecommendations(tenantId);
    const recommendations = recReport.recommendations || [];

    // 2. Get active platform accounts
    const accounts = await db
      .select()
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.tenantId, tenantId),
          eq(platformAccounts.status, "active"),
          eq(platformAccounts.isVerified, true)
        )
      );

    if (accounts.length === 0) {
      logger.warn({ tenantId }, "No verified platform accounts found, using default wechat");
    }

    // 3. Read tenant automationConfig
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const tenantConfig = (tenant?.config || {}) as Record<string, any>;
    const automationConfig = tenantConfig.automationConfig || {};
    const maxDailyArticles = automationConfig.dailyArticleLimit || automationConfig.maxDailyArticles || 5;

    // 4. Generate ContentTask for each topic x platform
    const contentTasks: ContentTask[] = [];
    const activePlatforms = accounts.length > 0
      ? [...new Set(accounts.map((a) => a.platform))]
      : ["wechat"];

    let taskIndex = 0;
    for (const rec of recommendations.slice(0, maxDailyArticles)) {
      for (const platform of activePlatforms) {
        const account = accounts.find((a) => a.platform === platform);
        const styleInfo = PLATFORM_STYLE_MAP[platform] || { style: "deep_analysis", wordCount: 1500 };
        const publishHour = PLATFORM_PUBLISH_HOURS[platform] || "09:00";

        const task: ContentTask = {
          id: nanoid(16),
          type: "article",
          topic: rec.createParams.topic || rec.keyword,
          style: styleInfo.style,
          platform,
          accountId: account?.id || "default",
          wordCount: rec.createParams.suggestedWordCount || styleInfo.wordCount,
          audience: rec.createParams.suggestedAudience || "学术研究者",
          referenceJournals: rec.relatedJournals?.map((j) => j.name) || [],
          scheduledPublishAt: `${date}T${publishHour}:00+08:00`,
          priority: taskIndex < 2 ? "high" : "normal",
          recommendationId: rec.id,
          status: "pending",
        };

        contentTasks.push(task);
        taskIndex++;
      }
    }

    const totalArticles = contentTasks.filter((t) => t.type === "article").length;
    const totalVideos = contentTasks.filter((t) => t.type === "video").length;

    const planId = nanoid(16);
    const now = new Date();

    // 5. Save to daily_content_plans（upsert 防止重复）
    await db.insert(dailyContentPlans).values({
      id: planId,
      tenantId,
      date,
      tasks: contentTasks as any,
      totalArticles,
      totalVideos,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [dailyContentPlans.tenantId, dailyContentPlans.date],
      set: {
        tasks: contentTasks as any,
        totalArticles,
        totalVideos,
        status: "draft",
        updatedAt: now,
      },
    });

    logger.info(
      { tenantId, date, planId, totalArticles, totalVideos },
      "DailyContentPlan generated"
    );

    return {
      id: planId,
      tenantId,
      date,
      tasks: contentTasks,
      totalArticles,
      totalVideos,
      status: "draft",
      generatedAt: now.toISOString(),
    };
  }
}
