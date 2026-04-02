/**
 * P3 数据采集与知识沉淀 API 路由
 *
 * 覆盖功能：
 * - 热点事件监控 (T303)
 * - 热点时间线 (T308)
 * - 领域知识采集 (T304)
 * - 竞品分析 (T301/T302)
 * - 数据素材结构化 (T309)
 * - AI质检 (T310)
 * - 风格学习 (T307)
 * - 调度管理 (T305)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { triggerJob, getJobStatus, getSchedulerStats, type SchedulerJobData } from "../services/scheduler.js";

// ============ 路由注册 ============

export async function dataCollectionRoutes(app: FastifyInstance) {

  // ===== 热点事件 =====

  /** 手动触发热点事件监控 */
  app.post("/hot-events/detect", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { detectHotEvents } = await import("../services/data-collection/hot-event-monitor.js");
    const events = await detectHotEvents(tenantId);
    return { events, count: events.length };
  });

  /** 获取事件时间线 */
  app.get("/hot-events/timeline", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { getActiveEventTimelines } = await import("../services/data-collection/hot-event-timeline.js");
    const timelines = await getActiveEventTimelines(tenantId);
    return { timelines, count: timelines.length };
  });

  /** 获取单个事件的时间线 */
  app.post("/hot-events/timeline/build", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({ eventTitle: z.string().min(2) });
    const { eventTitle } = schema.parse(request.body);
    const { buildEventTimeline } = await import("../services/data-collection/hot-event-timeline.js");
    const timeline = await buildEventTimeline(eventTitle, tenantId);
    if (!timeline) return reply.status(404).send({ error: "未找到相关事件" });
    return timeline;
  });

  // ===== 领域知识 =====

  /** 手动触发领域知识采集 */
  app.post("/domain-knowledge/collect", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { collectDomainKnowledge } = await import("../services/data-collection/domain-knowledge-collector.js");
    const result = await collectDomainKnowledge(tenantId);
    return result;
  });

  // ===== 竞品分析 =====

  /** 分析单个竞品账号 */
  app.post("/competitors/analyze-account", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({ accountId: z.string().min(1) });
    const { accountId } = schema.parse(request.body);
    const { analyzeCompetitorAccount } = await import("../services/data-collection/competitor-analyzer.js");
    const analysis = await analyzeCompetitorAccount(tenantId, accountId);
    if (!analysis) return reply.status(404).send({ error: "未找到该竞品账号的内容数据" });
    return analysis;
  });

  /** 手动触发竞品内容拆解 */
  app.post("/competitors/analyze-content", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { analyzeCompetitorContent } = await import("../services/data-collection/competitor-analyzer.js");
    const result = await analyzeCompetitorContent(tenantId);
    return result;
  });

  // ===== 数据素材 =====

  /** 从文本中提取结构化数据 */
  app.post("/data-materials/extract", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({
      content: z.string().min(50),
      source: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const { extractStructuredData } = await import("../services/data-collection/data-structurizer.js");
    const result = await extractStructuredData(body.content, tenantId, body.source);
    return result;
  });

  // ===== AI 质检 =====

  /** 单篇内容质检 */
  app.post("/quality-check/:contentId", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { contentId } = request.params as { contentId: string };
    const { checkContentQuality } = await import("../services/data-collection/quality-check-engine.js");
    const report = await checkContentQuality(contentId, tenantId);
    if (!report) return reply.status(404).send({ error: "内容不存在" });
    return report;
  });

  /** 批量质检 */
  app.post("/quality-check/batch", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { batchQualityCheck } = await import("../services/data-collection/quality-check-engine.js");
    const result = await batchQualityCheck(tenantId);
    return result;
  });

  // ===== 风格学习 =====

  /** 手动触发风格学习 */
  app.post("/style-learning/run", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { autoLearnStyle } = await import("../services/data-collection/style-learning-enhanced.js");
    const result = await autoLearnStyle(tenantId);
    return result;
  });

  // ===== 调度管理 =====

  /** 手动触发调度任务 */
  app.post("/scheduler/trigger", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({
      type: z.enum([
        "daily-crawl", "crawl-track", "crawl-platform",
        "keyword-analysis", "hot-event-monitor", "domain-knowledge",
        "competitor-analysis", "style-learning", "quality-check",
      ]),
      platform: z.string().optional(),
      track: z.enum(["domestic", "sci", "social"]).optional(),
    });
    const body = schema.parse(request.body);
    const jobData: SchedulerJobData = {
      type: body.type,
      tenantId,
      platform: body.platform as any,
      track: body.track,
    };
    const result = await triggerJob(jobData);
    return result;
  });

  /** 查询任务状态 */
  app.get("/scheduler/job/:jobId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { jobId } = request.params as { jobId: string };
    const status = await getJobStatus(jobId);
    if (!status) return reply.status(404).send({ error: "任务不存在" });
    return status;
  });

  /** 调度器统计 */
  app.get("/scheduler/stats", async (_request: FastifyRequest, _reply: FastifyReply) => {
    return getSchedulerStats();
  });
}
