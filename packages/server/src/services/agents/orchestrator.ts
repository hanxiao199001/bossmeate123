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
import { dailyContentPlans, tenants, contents, users, journals } from "../../models/schema.js";
import { eq, and, gte, sql, ilike } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { contentQueue } from "../task/queue.js";
import { logAgentAction, updateAgentLog } from "./base/agent-logger.js";
import { agentRegistry } from "./base/registry.js";
import { emitProgress, emitDone } from "./base/progress-emitter.js";
import { crawlAll } from "../crawler/index.js";
import { analyzeKeywords } from "./keyword-analyzer.js";
import { getTrendReport } from "./keyword-trend.js";
import { sinkTrendData, sinkRecommendations } from "../data-collection/crawl-data-sink.js";
import { prefetchJournalCovers } from "../crawler/journal-cover-prefetch.js";
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
  private config: AgentConfig = { concurrency: 1, maxRetries: 3, timeoutMs: 1_800_000 };

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
    const runId = context.runId || "";

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

    // ── Step 0a: 数据抓取（仅手动触发时执行） ──
    if (context.triggeredBy === "manual") {
      if (runId) emitProgress({ runId, step: "data-crawl", label: "数据抓取", status: "running", progress: 0 });

      try {
        const crawlerResults = await crawlAll();
        details.push({ step: "data-crawl", platforms: crawlerResults.length });
        tasksCompleted++;
        if (runId) emitProgress({ runId, step: "data-crawl", label: "数据抓取", status: "completed", progress: 10 });

        // ── Step 0b: 关键词分析 ──
        if (runId) emitProgress({ runId, step: "keyword-analysis", label: "关键词分析", status: "running", progress: 10 });

        const activeTenants = context.tenantId
          ? [{ id: context.tenantId }]
          : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

        for (const t of activeTenants) {
          try {
            await analyzeKeywords(crawlerResults, t.id);
            logger.info({ tenantId: t.id }, "关键词分析完成");
          } catch (err) {
            logger.error({ tenantId: t.id, err }, "关键词分析失败");
          }
        }

        // 生成每日选题推荐
        const { generateDailyRecommendations } = await import("../content-engine/topic-recommender.js");
        for (const t of activeTenants) {
          try {
            await generateDailyRecommendations(t.id);
            logger.info({ tenantId: t.id }, "选题推荐已生成");
          } catch (err) {
            logger.error({ tenantId: t.id, err }, "选题推荐生成失败");
          }
        }

        tasksCompleted++;
        details.push({ step: "keyword-analysis", tenants: activeTenants.length });
        if (runId) emitProgress({ runId, step: "keyword-analysis", label: "关键词分析", status: "completed", progress: 25 });
      } catch (err: any) {
        logger.error({ err }, "数据抓取失败");
        details.push({ step: "data-crawl", error: err.message });
        tasksFailed++;
        if (runId) {
          emitProgress({ runId, step: "data-crawl", label: "数据抓取", status: "failed", progress: 10, error: err.message });
          emitProgress({ runId, step: "keyword-analysis", label: "关键词分析", status: "failed", progress: 25, error: "数据抓取失败，跳过" });
        }
      }
    }

    // ── Step 1: Call KnowledgeEngine ──
    if (runId) emitProgress({ runId, step: "knowledge-engine", label: "知识引擎", status: "running", progress: 30 });

    const knowledgeEngine = agentRegistry.get("knowledge-engine");
    if (knowledgeEngine) {
      try {
        const keResult = await knowledgeEngine.execute(context);
        details.push({ step: "knowledge-engine", ...keResult });
        if (keResult.success) {
          tasksCompleted++;
          if (runId) emitProgress({ runId, step: "knowledge-engine", label: "知识引擎", status: "completed", progress: 45 });
        } else {
          tasksFailed++;
          if (runId) emitProgress({ runId, step: "knowledge-engine", label: "知识引擎", status: "failed", progress: 45, error: keResult.summary });
        }
      } catch (err: any) {
        logger.error({ err }, "KnowledgeEngine execution failed in orchestrator");
        details.push({ step: "knowledge-engine", error: err.message });
        tasksFailed++;
        if (runId) emitProgress({ runId, step: "knowledge-engine", label: "知识引擎", status: "failed", progress: 45, error: err.message });
      }
    } else {
      logger.warn("KnowledgeEngine not registered, skipping");
      details.push({ step: "knowledge-engine", skipped: true });
      if (runId) emitProgress({ runId, step: "knowledge-engine", label: "知识引擎", status: "completed", progress: 45 });
    }

    // ── Step 2: Call ContentDirector ──
    if (runId) emitProgress({ runId, step: "content-director", label: "内容规划", status: "running", progress: 45 });

    const contentDirector = agentRegistry.get("content-director");
    if (contentDirector) {
      try {
        const cdResult = await contentDirector.execute(context);
        details.push({ step: "content-director", ...cdResult });
        if (cdResult.success) {
          tasksCompleted++;
          if (runId) emitProgress({ runId, step: "content-director", label: "内容规划", status: "completed", progress: 60 });
        } else {
          tasksFailed++;
          if (runId) emitProgress({ runId, step: "content-director", label: "内容规划", status: "failed", progress: 60, error: cdResult.summary });
        }
      } catch (err: any) {
        logger.error({ err }, "ContentDirector execution failed in orchestrator");
        details.push({ step: "content-director", error: err.message });
        tasksFailed++;
        if (runId) emitProgress({ runId, step: "content-director", label: "内容规划", status: "failed", progress: 60, error: err.message });
      }
    } else {
      logger.warn("ContentDirector not registered, skipping");
      details.push({ step: "content-director", skipped: true });
      if (runId) emitProgress({ runId, step: "content-director", label: "内容规划", status: "completed", progress: 60 });
    }

    // ── Step 2.5: 知识沉淀（趋势 + 推荐 → 知识库）──
    // 非阻塞：沉淀失败不影响主流程
    try {
      // 钩子1：趋势关键词 → hot_event 子库
      const trendReport = await getTrendReport(context.tenantId);
      const allTrends = [...trendReport.exploding, ...trendReport.rising];
      if (allTrends.length > 0) {
        const sinkResult1 = await sinkTrendData(allTrends, context.tenantId, context.date);
        details.push({ step: "sink-trends", ingested: sinkResult1.ingested, rejected: sinkResult1.rejected });
      }

      // 钩子2：选题推荐 → insight 子库
      const sinkResult2 = await sinkRecommendations(context.tenantId, context.date);
      details.push({ step: "sink-recommendations", ingested: sinkResult2.ingested, rejected: sinkResult2.rejected });

      logger.info({ tenantId: context.tenantId }, "知识沉淀完成");
    } catch (err: any) {
      logger.warn({ err: err.message }, "知识沉淀失败（非阻塞，不影响主流程）");
      details.push({ step: "knowledge-sink", error: err.message });
    }

    // ── Step 3: Read today's plan ──
    if (runId) emitProgress({ runId, step: "read-plan", label: "读取计划", status: "running", progress: 60 });

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
      if (runId) {
        emitProgress({ runId, step: "read-plan", label: "读取计划", status: "failed", progress: 75, error: "未生成今日计划" });
        emitDone({ runId, success: false, summary: "未生成今日内容计划" });
      }
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

    if (runId) emitProgress({ runId, step: "read-plan", label: "读取计划", status: "completed", progress: 75 });

    // ── Step 3.5: 根据今日选题，定向预抓取相关期刊封面图 ──
    try {
      const planTasks = (plan.tasks || []) as ContentTask[];
      const articleTasks = planTasks.filter((t) => t.type === "article");

      // 提取选题关键词 + 显式引用的期刊名
      const topics = [...new Set(articleTasks.map((t) => t.topic).filter(Boolean))];
      const refJournals = [...new Set(articleTasks.flatMap((t) => t.referenceJournals || []).filter(Boolean))];

      if (topics.length > 0 || refJournals.length > 0) {
        const coverResult = await prefetchJournalCovers(context.tenantId, topics, refJournals);
        details.push({
          step: "cover-prefetch",
          topics: topics.length,
          matched: coverResult.total + coverResult.skipped,
          success: coverResult.success,
          failed: coverResult.failed,
          alreadyCached: coverResult.skipped,
          sources: coverResult.sources,
        });
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "期刊封面定向预抓取失败（非阻塞）");
      details.push({ step: "cover-prefetch", error: err.message });
    }

    // ── Step 4: Read tenant automationConfig.stage ──
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, context.tenantId))
      .limit(1);

    const tenantConfig = (tenant?.config || {}) as Record<string, any>;
    const automationConfig = tenantConfig.automationConfig || {};
    const stage = automationConfig.stage || "learning"; // learning | semi_auto | full_auto

    // ── Step 5: Add article tasks to contentQueue ──
    if (runId) emitProgress({ runId, step: "queue-tasks", label: "任务排队", status: "running", progress: 80 });

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

    // ── Step 5b: 视频任务异步入队（setImmediate 完全隔离，不阻塞图文） ──
    const videoTasks = planTasks.filter((t) => t.type === "video");
    if (videoTasks.length > 0) {
      logger.info({ count: videoTasks.length }, "开始处理视频任务");
      const tenantIdCapture = context.tenantId;
      const planIdCapture = plan.id;

      for (const task of videoTasks) {
        const topicCapture = task.topic;
        const platformCapture = task.platform;
        const referenceJournalName = task.referenceJournals?.[0];

        setImmediate(async () => {
          try {
            // 获取 tenant 下的真实 userId（contents.user_id 是 UUID 外键）
            const [tenantUser] = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantIdCapture)).limit(1);
            const userId = tenantUser?.id || tenantIdCapture;

            // 尝试定位关联期刊：优先 referenceJournals 名称匹配，其次 topic 模糊匹配
            let journalId: string | undefined;
            const searchName = referenceJournalName || topicCapture;
            if (searchName) {
              try {
                const [row] = await db
                  .select({ id: journals.id })
                  .from(journals)
                  .where(and(eq(journals.tenantId, tenantIdCapture), ilike(journals.name, `%${searchName}%`)))
                  .limit(1);
                if (row) journalId = row.id;
              } catch (err) {
                logger.warn({ err: err instanceof Error ? err.message : err, searchName }, "期刊匹配失败，走关键词兜底");
              }
            }

            const { produceVideo } = await import("../video/index.js");
            logger.info({ topic: topicCapture, journalId }, "视频合成开始");
            const videoResult = await produceVideo({
              tenantId: tenantIdCapture,
              title: topicCapture,
              journalId,
              scenes: [
                { voiceoverText: `今天给大家介绍：${topicCapture}`, visualKeywords: [topicCapture, "journal"], durationMs: 4000, subtitle: `${topicCapture} · 期刊速览` },
                { voiceoverText: `${topicCapture}的核心优势`, visualKeywords: [topicCapture, "research"], durationMs: 5000, subtitle: "期刊定位 · 影响因子 · 分区" },
                { voiceoverText: `审稿效率与录用率参考`, visualKeywords: ["review", "academic"], durationMs: 5000, subtitle: "审稿周期 · 录用率" },
                { voiceoverText: `投稿建议：选题贴合刊物定位，格式严格遵守作者须知`, visualKeywords: ["writing", "manuscript"], durationMs: 5000, subtitle: "投稿建议" },
                { voiceoverText: `想了解更多期刊，关注主页`, visualKeywords: ["subscribe", "follow"], durationMs: 3000, subtitle: "关注 · 获取更多期刊分析" },
              ],
            });
            logger.info({ topic: topicCapture, url: videoResult.url }, "视频合成完成，开始写入 DB");
            try {
              await db.insert(contents).values({
                tenantId: tenantIdCapture,
                userId,
                type: "video",
                title: topicCapture,
                body: videoResult.url,
                status: "draft",
                metadata: {
                  videoUrl: videoResult.url,
                  durationMs: videoResult.durationMs,
                  sizeBytes: videoResult.sizeBytes,
                  scenesCount: videoResult.scenesCount,
                  planId: planIdCapture,
                  platform: platformCapture,
                },
              });
              logger.info({ topic: topicCapture }, "视频记录写入 contents 成功");
            } catch (dbErr) {
              logger.error({ err: dbErr instanceof Error ? dbErr.message : dbErr, topic: topicCapture }, "视频记录写入 contents 失败");
            }
          } catch (err) {
            logger.error({ err: err instanceof Error ? err.message : err, topic: topicCapture }, "视频合成失败");
          }
        });
        queued++;
      }
    }

    // ── Step 6: Update plan status ──
    await db
      .update(dailyContentPlans)
      .set({ status: "executing", updatedAt: new Date() })
      .where(eq(dailyContentPlans.id, plan.id));

    tasksCompleted++;

    if (runId) emitProgress({ runId, step: "queue-tasks", label: "任务排队", status: "completed", progress: 100 });

    const durationMs = Date.now() - start;
    await updateAgentLog(logId, {
      status: "completed",
      output: { planId: plan.id, queued, stage },
      durationMs,
    });

    this.status = "idle";

    const result: AgentResult = {
      agentName: this.name,
      success: true,
      tasksCompleted,
      tasksFailed,
      summary: `Orchestrator: ${queued} tasks queued (stage=${stage})`,
      details: [...details, { step: "queue", queued, stage, planId: plan.id }],
      durationMs,
    };

    if (runId) emitDone({ runId, success: true, summary: result.summary });

    return result;
  }
}

// ============ Helpers ============

function buildArticleInstruction(task: ContentTask): string {
  // V6: 期刊推荐文章模式
  // 如果有参考期刊，以第一个期刊为主角；否则用关键词找期刊
  const targetJournal = task.referenceJournals?.[0] || "";

  if (targetJournal) {
    // 有明确期刊 → 直接推荐该期刊
    return [
      `请生成一篇关于期刊"${targetJournal}"的推荐文章。`,
      `研究方向关键词: ${task.topic}`,
      `目标平台: ${task.platform}`,
      `目标受众: ${task.audience}`,
    ].join("\n");
  }

  // 无明确期刊 → 根据关键词推荐合适的期刊
  return [
    `请根据研究方向"${task.topic}"推荐一个适合投稿的SCI/SSCI期刊，并生成期刊推荐文章。`,
    `目标平台: ${task.platform}`,
    `目标受众: ${task.audience}`,
  ].join("\n");
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

  // 查询今日 AI 生成的 contents 状态统计
  const todayStart = new Date(`${today}T00:00:00`);
  let contentStatusCounts: Record<string, number> = {};
  try {
    const todayContents = await db
      .select({ status: contents.status })
      .from(contents)
      .where(
        and(
          eq(contents.tenantId, tenantId),
          gte(contents.createdAt, todayStart),
          sql`(${contents.metadata}->>'agentGenerated')::boolean = true`
        )
      );

    for (const c of todayContents) {
      contentStatusCounts[c.status] = (contentStatusCounts[c.status] || 0) + 1;
    }
  } catch (err) {
    logger.warn({ err }, "getDailyProgress: 查询 contents 统计失败");
  }

  return {
    date: today,
    hasPlan: true,
    planId: plan.id,
    totalArticles: plan.totalArticles,
    totalVideos: plan.totalVideos,
    planStatus: plan.status,
    taskStatusCounts: statusCounts,
    contentStatusCounts,
    tasks: tasks.map((t) => ({
      id: t.id,
      topic: t.topic,
      platform: t.platform,
      status: t.status,
      scheduledPublishAt: t.scheduledPublishAt,
    })),
  };
}
