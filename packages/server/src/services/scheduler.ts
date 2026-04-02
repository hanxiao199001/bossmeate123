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
import { tenants } from "../models/schema.js";
import { eq } from "drizzle-orm";
import { getRedisConnection, crawlerQueue } from "./task/queue.js";
import type { PlatformName, CrawlerTrack } from "./crawler/types.js";

// ============ 任务类型 ============

export type SchedulerJobType =
  | "daily-crawl"          // 每日全量爬虫
  | "crawl-track"          // 按业务线爬虫
  | "crawl-platform"       // 单平台爬虫
  | "keyword-analysis"     // 关键词分析
  | "hot-event-monitor"    // 热点事件监控
  | "domain-knowledge"     // 领域知识采集
  | "competitor-analysis"  // 竞品内容拆解
  | "style-learning"       // 风格学习
  | "quality-check";       // 批量质检

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

  logger.info("📅 Cron 定时任务注册完成");
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
