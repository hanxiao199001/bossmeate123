/**
 * 定时任务调度器（BullMQ 版）
 *
 * 基于 BullMQ 的可持久化任务调度，支持：
 * - cron 定时触发
 * - 失败重试（指数退避）
 * - 任务持久化（Redis 重启不丢）
 * - 多种任务类型：爬虫、关键词分析、热点监控、领域知识采集、竞品拆解、质检
 */

import { Worker, Queue } from "bullmq";
import { logger } from "../config/logger.js";
import { crawlAll, crawlByTrack, crawlPlatform } from "./crawler/index.js";
import { analyzeKeywords } from "./agents/keyword-analyzer.js";
import { db } from "../models/db.js";
import { tenants, contents } from "../models/schema.js";
import { eq, and, lt, inArray } from "drizzle-orm";
import { getRedisConnection, crawlerQueue } from "./task/queue.js";
import type { PlatformName, CrawlerTrack } from "./crawler/types.js";

// ============ 任务类型 ============

export type SchedulerJobType =
  | "daily-crawl"              // 每日全量爬虫（三条线）
  | "crawl-track"              // 按业务线爬虫
  | "crawl-platform"           // 单平台爬虫
  | "keyword-analysis"         // 关键词分析
  | "hot-event-monitor"        // 热点事件监控
  | "domain-knowledge"         // 领域知识采集
  | "competitor-analysis"      // 竞品内容拆解
  | "style-learning"           // 风格学习
  | "quality-check"            // 批量质检
  | "knowledge-engine"         // 知识引擎 Agent
  | "orchestrator"             // 总指挥 Agent
  | "midday-knowledge"         // 午间知识补充
  | "evening-knowledge"        // 晚间知识补充
  | "journal-catalog-update"   // 月度期刊基础库更新（Springer + LetPub）
  | "heat-journal-match"       // 热度×期刊交叉匹配
  | "journal-cover-prefetch"   // 期刊封面图预抓取
  | "stale-review-cleanup";    // 清理超时未审核内容（3天）

export interface SchedulerJobData {
  type: SchedulerJobType;
  tenantId?: string;
  platform?: PlatformName;
  track?: CrawlerTrack;
  payload?: Record<string, unknown>;
}

// ============ Worker 处理器 ============

let schedulerWorker: Worker | null = null;

async function processJob(job: { name: string; data: SchedulerJobData }) {
  const { type, tenantId, platform, track } = job.data;
  logger.info({ type, tenantId, platform }, `⏰ 调度任务开始: ${type}`);

  switch (type) {
    case "daily-crawl": {
      const crawlerResults = await crawlAll();

      const activeTenants = await db
        .select()
        .from(tenants)
        .where(eq(tenants.status, "active"));

      for (const tenant of activeTenants) {
        try {
          await analyzeKeywords(crawlerResults, tenant.id);
          logger.info({ tenantId: tenant.id }, "租户关键词分析完成");
        } catch (err) {
          logger.error({ tenantId: tenant.id, err }, "租户关键词分析失败");
        }
      }

      // 生成每日选题推荐
      const { generateDailyRecommendations } = await import("./content-engine/topic-recommender.js");
      for (const tenant of activeTenants) {
        try {
          await generateDailyRecommendations(tenant.id);
          logger.info({ tenantId: tenant.id }, "今日选题推荐已生成");
        } catch (err) {
          logger.error({ tenantId: tenant.id, err }, "选题推荐生成失败");
        }
      }

      return { totalPlatforms: crawlerResults.length, tenantCount: activeTenants.length };
    }

    case "crawl-track": {
      if (!track) throw new Error("缺少 track 参数");
      const results = await crawlByTrack(track);
      return { track, count: results.length };
    }

    case "crawl-platform": {
      if (!platform) throw new Error("缺少 platform 参数");
      const result = await crawlPlatform(platform);
      return { platform, success: result.success, keywords: result.keywords.length };
    }

    case "keyword-analysis": {
      if (!tenantId) throw new Error("缺少 tenantId");
      const crawlerResults = await crawlAll();
      await analyzeKeywords(crawlerResults, tenantId);
      return { tenantId, keywords: crawlerResults.reduce((s, r) => s + r.keywords.length, 0) };
    }

    case "hot-event-monitor": {
      const { detectHotEvents } = await import("./data-collection/hot-event-monitor.js");
      if (tenantId) {
        const events = await detectHotEvents(tenantId);
        return { tenantId, eventsDetected: events.length };
      }
      const activeTenants = await db.select().from(tenants).where(eq(tenants.status, "active"));
      let total = 0;
      for (const t of activeTenants) {
        const events = await detectHotEvents(t.id);
        total += events.length;
      }
      return { tenantsProcessed: activeTenants.length, totalEvents: total };
    }

    case "domain-knowledge": {
      const { collectDomainKnowledge } = await import("./data-collection/domain-knowledge-collector.js");
      if (!tenantId) throw new Error("缺少 tenantId");
      const result = await collectDomainKnowledge(tenantId);
      return result;
    }

    case "competitor-analysis": {
      const { analyzeCompetitorContent } = await import("./data-collection/competitor-analyzer.js");
      if (!tenantId) throw new Error("缺少 tenantId");
      const result = await analyzeCompetitorContent(tenantId);
      return result;
    }

    case "style-learning": {
      const { autoLearnStyle } = await import("./data-collection/style-learning-enhanced.js");
      if (!tenantId) throw new Error("缺少 tenantId");
      const result = await autoLearnStyle(tenantId);
      return result;
    }

    case "quality-check": {
      const { batchQualityCheck } = await import("./data-collection/quality-check-engine.js");
      if (!tenantId) throw new Error("缺少 tenantId");
      const result = await batchQualityCheck(tenantId);
      return result;
    }

    case "knowledge-engine":
    case "midday-knowledge":
    case "evening-knowledge": {
      const { agentRegistry } = await import("./agents/base/registry.js");
      const activeTenants = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      const agent = agentRegistry.get("knowledge-engine");
      if (!agent) throw new Error("KnowledgeEngine agent not registered");

      let totalCompleted = 0;
      for (const t of activeTenants) {
        try {
          const result = await agent.execute({
            tenantId: t.id,
            date: new Date().toISOString().slice(0, 10),
            triggeredBy: "scheduler",
          });
          if (result.success) totalCompleted++;
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "KnowledgeEngine execution failed");
        }
      }
      return { tenantsProcessed: activeTenants.length, totalCompleted };
    }

    case "orchestrator": {
      const { agentRegistry: registry } = await import("./agents/base/registry.js");
      const activeTenants = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      const agent = registry.get("orchestrator");
      if (!agent) throw new Error("Orchestrator agent not registered");

      let totalCompleted = 0;
      for (const t of activeTenants) {
        try {
          const result = await agent.execute({
            tenantId: t.id,
            date: new Date().toISOString().slice(0, 10),
            triggeredBy: "scheduler",
          });
          if (result.success) totalCompleted++;
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "Orchestrator execution failed");
        }
      }
      return { tenantsProcessed: activeTenants.length, totalCompleted };
    }

    case "journal-catalog-update": {
      // 月度：Springer Link 期刊基础库更新
      const { SpringerLinkCrawler } = await import("./crawler/springer-link-crawler.js");
      const springerCrawler = new SpringerLinkCrawler();

      const proxy = process.env.SPRINGER_PROXY || undefined;
      const result = await springerCrawler.crawlJournalCatalog({
        proxy,
        maxDetails: 30,
      });
      return result;
    }

    case "heat-journal-match": {
      // 热度信号 × 期刊库交叉匹配
      const { getTodayHeatMatches } = await import("./content-engine/journal-heat-matcher.js");
      const activeTenants = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      let totalMatches = 0;
      for (const t of activeTenants) {
        try {
          const matches = await getTodayHeatMatches(t.id, 20);
          totalMatches += matches.length;
          logger.info({ tenantId: t.id, matches: matches.length }, "Heat-journal match completed");
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "Heat-journal match failed");
        }
      }
      return { tenantsProcessed: activeTenants.length, totalMatches };
    }

    case "journal-cover-prefetch": {
      // 期刊封面图预抓取 — 根据今日选题定向抓取
      const { prefetchJournalCovers } = await import("./crawler/journal-cover-prefetch.js");
      const { keywords: kwTable } = await import("../models/schema.js");
      const { desc: descOrder } = await import("drizzle-orm");

      const activeTenantsForCover = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      let totalSuccess = 0;
      let totalFailed = 0;

      for (const t of activeTenantsForCover) {
        try {
          // 获取今日热门关键词作为选题
          const topKeywords = await db
            .select({ keyword: kwTable.keyword })
            .from(kwTable)
            .where(eq(kwTable.tenantId, t.id))
            .orderBy(descOrder(kwTable.compositeScore))
            .limit(10);

          const topics = topKeywords.map((k) => k.keyword);
          const result = await prefetchJournalCovers(t.id, topics);
          totalSuccess += result.success;
          totalFailed += result.failed;
          logger.info({ tenantId: t.id, ...result }, "期刊封面预抓取完成");
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "期刊封面预抓取失败");
        }
      }
      return { tenantsProcessed: activeTenantsForCover.length, totalSuccess, totalFailed };
    }

    case "stale-review-cleanup": {
      // 清理超过 3 天仍处于 reviewing / draft 状态的内容
      const STALE_DAYS = 3;
      const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

      const staleRows = await db
        .select({ id: contents.id, title: contents.title, status: contents.status })
        .from(contents)
        .where(
          and(
            inArray(contents.status, ["reviewing", "draft"]),
            lt(contents.createdAt, cutoff)
          )
        );

      if (staleRows.length === 0) {
        logger.info("🧹 无超时未审核内容需要清理");
        return { deleted: 0 };
      }

      const staleIds = staleRows.map((r) => r.id);

      // 分批删除关联的 production_records 和 distribution_records
      const { productionRecords, distributionRecords } = await import("../models/schema.js");
      await db.delete(distributionRecords).where(inArray(distributionRecords.contentId, staleIds));
      await db.delete(productionRecords).where(inArray(productionRecords.contentId, staleIds));
      await db.delete(contents).where(inArray(contents.id, staleIds));

      logger.info(
        { count: staleRows.length, titles: staleRows.map((r) => r.title).slice(0, 5) },
        `🧹 已清理 ${staleRows.length} 条超过 ${STALE_DAYS} 天未审核的内容`
      );
      return { deleted: staleRows.length, cutoffDate: cutoff.toISOString() };
    }

    default:
      throw new Error(`未知任务类型: ${type}`);
  }
}

// ============ 启动调度器 ============

export function startScheduler() {
  const connection = getRedisConnection();

  // 创建 Worker
  schedulerWorker = new Worker(
    "crawler",
    async (job) => processJob(job),
    {
      connection,
      concurrency: 2,
      limiter: { max: 3, duration: 60000 },
    }
  );

  schedulerWorker.on("completed", (job, result) => {
    logger.info({ jobId: job?.id, type: job?.data?.type, result }, "⏰ 调度任务完成");
  });

  schedulerWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, type: job?.data?.type, err: err.message }, "⏰ 调度任务失败");
  });

  // 注册 cron 定时任务
  registerCronJobs();

  logger.info("📅 BullMQ 调度器启动完成");
}

async function registerCronJobs() {
  // 每日 7:00 全量爬虫 + 关键词分析
  await crawlerQueue.upsertJobScheduler(
    "daily-crawl-schedule",
    { pattern: "0 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "daily-crawl",
      data: { type: "daily-crawl" as SchedulerJobType },
    }
  );

  // 每日 8:00 热点事件监控
  await crawlerQueue.upsertJobScheduler(
    "hot-event-schedule",
    { pattern: "0 8 * * *", tz: "Asia/Shanghai" },
    {
      name: "hot-event-monitor",
      data: { type: "hot-event-monitor" as SchedulerJobType },
    }
  );

  // 每日 9:00 竞品内容拆解
  await crawlerQueue.upsertJobScheduler(
    "competitor-schedule",
    { pattern: "0 9 * * *", tz: "Asia/Shanghai" },
    {
      name: "competitor-analysis",
      data: { type: "competitor-analysis" as SchedulerJobType },
    }
  );

  // 每周一 6:00 领域知识采集
  await crawlerQueue.upsertJobScheduler(
    "domain-knowledge-schedule",
    { pattern: "0 6 * * 1", tz: "Asia/Shanghai" },
    {
      name: "domain-knowledge",
      data: { type: "domain-knowledge" as SchedulerJobType },
    }
  );

  // 每周日 22:00 风格学习
  await crawlerQueue.upsertJobScheduler(
    "style-learning-schedule",
    { pattern: "0 22 * * 0", tz: "Asia/Shanghai" },
    {
      name: "style-learning",
      data: { type: "style-learning" as SchedulerJobType },
    }
  );

  // 每日 6:30 知识引擎
  await crawlerQueue.upsertJobScheduler(
    "knowledge-engine-schedule",
    { pattern: "30 6 * * *", tz: "Asia/Shanghai" },
    {
      name: "knowledge-engine",
      data: { type: "knowledge-engine" as SchedulerJobType },
    }
  );

  // 每日 7:00 总指挥（知识+选题+排队生产）
  await crawlerQueue.upsertJobScheduler(
    "orchestrator-schedule",
    { pattern: "0 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "orchestrator",
      data: { type: "orchestrator" as SchedulerJobType },
    }
  );

  // 每日 11:00 午间知识补充
  await crawlerQueue.upsertJobScheduler(
    "midday-knowledge-schedule",
    { pattern: "0 11 * * *", tz: "Asia/Shanghai" },
    {
      name: "midday-knowledge",
      data: { type: "midday-knowledge" as SchedulerJobType },
    }
  );

  // 每日 20:00 晚间知识补充
  await crawlerQueue.upsertJobScheduler(
    "evening-knowledge-schedule",
    { pattern: "0 20 * * *", tz: "Asia/Shanghai" },
    {
      name: "evening-knowledge",
      data: { type: "evening-knowledge" as SchedulerJobType },
    }
  );

  // 每月1号 3:00 期刊基础库全量更新（Springer Link）
  await crawlerQueue.upsertJobScheduler(
    "journal-catalog-schedule",
    { pattern: "0 3 1 * *", tz: "Asia/Shanghai" },
    {
      name: "journal-catalog-update",
      data: { type: "journal-catalog-update" as SchedulerJobType },
    }
  );

  // 每日 7:30 热度×期刊交叉匹配（在爬虫+关键词分析之后）
  await crawlerQueue.upsertJobScheduler(
    "heat-journal-match-schedule",
    { pattern: "30 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "heat-journal-match",
      data: { type: "heat-journal-match" as SchedulerJobType },
    }
  );

  // 每日 7:45 期刊封面图预抓取（在热度匹配之后，内容生产之前）
  await crawlerQueue.upsertJobScheduler(
    "journal-cover-prefetch-schedule",
    { pattern: "45 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "journal-cover-prefetch",
      data: { type: "journal-cover-prefetch" as SchedulerJobType },
    }
  );

  // 每日 2:00 清理超过 3 天未审核的内容
  await crawlerQueue.upsertJobScheduler(
    "stale-review-cleanup-schedule",
    { pattern: "0 2 * * *", tz: "Asia/Shanghai" },
    {
      name: "stale-review-cleanup",
      data: { type: "stale-review-cleanup" as SchedulerJobType },
    }
  );

  logger.info("📅 Cron 定时任务注册完成（含月度期刊更新 + 每日热度匹配 + 封面预抓取 + 超时审核清理）");
}

// ============ 手动触发接口 ============

export async function triggerJob(data: SchedulerJobData) {
  const job = await crawlerQueue.add(data.type, data, {
    priority: 1,
  });
  logger.info({ jobId: job.id, type: data.type }, "手动触发调度任务");
  return { jobId: job.id };
}

export async function getJobStatus(jobId: string) {
  const job = await crawlerQueue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    id: job.id,
    type: job.data.type,
    state,
    progress: job.progress,
    result: job.returnvalue,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn,
  };
}

export async function getSchedulerStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    crawlerQueue.getWaitingCount(),
    crawlerQueue.getActiveCount(),
    crawlerQueue.getCompletedCount(),
    crawlerQueue.getFailedCount(),
    crawlerQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

// ============ 停止调度器 ============

export async function stopScheduler() {
  if (schedulerWorker) {
    await schedulerWorker.close();
    schedulerWorker = null;
    logger.info("调度器已停止");
  }
}
