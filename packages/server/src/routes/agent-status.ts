/**
 * Agent 系统 API 路由
 * - Agent 状态查询
 * - 每日计划查询
 * - 内容审核（approve/edit/reject）
 * - 自动化配置
 */

import type { FastifyInstance } from "fastify";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { agentRegistry } from "../services/agents/base/registry.js";
import { createRun, getRunState } from "../services/agents/base/progress-emitter.js";
import { db } from "../models/db.js";
import {
  dailyContentPlans,
  agentLogs,
  bossEdits,
  contents,
  tenants,
  scheduledPublishes,
} from "../models/schema.js";

export async function agentRoutes(app: FastifyInstance) {
  // ===== Agent 状态 =====

  // GET /agents/status
  app.get("/status", async (request) => {
    const agents = agentRegistry.list();
    return { code: "OK", data: { agents } };
  });

  // GET /agents/daily-plan
  app.get("/daily-plan", async (request) => {
    const today = new Date().toISOString().slice(0, 10);
    const [plan] = await db
      .select()
      .from(dailyContentPlans)
      .where(
        and(
          eq(dailyContentPlans.tenantId, request.tenantId),
          eq(dailyContentPlans.date, today)
        )
      )
      .limit(1);
    return { code: "OK", data: { plan: plan || null } };
  });

  // GET /agents/logs?limit=20
  app.get("/logs", async (request) => {
    const { limit = "20" } = request.query as { limit?: string };
    const logs = await db
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.tenantId, request.tenantId))
      .orderBy(desc(agentLogs.createdAt))
      .limit(Number(limit));
    return { code: "OK", data: { logs } };
  });

  // POST /agents/:name/trigger — 手动触发（异步执行 + 轮询进度）
  app.post("/:name/trigger", async (request, reply) => {
    const { name } = request.params as { name: string };
    const agent = agentRegistry.get(name);
    if (!agent) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `Agent "${name}" not found` });
    }

    if (name === "orchestrator") {
      // Orchestrator：异步执行，前端通过轮询获取进度
      const runId = nanoid(12);
      createRun(request.tenantId, runId);

      // 后台异步执行，不阻塞响应
      agent.execute({
        tenantId: request.tenantId,
        date: new Date().toISOString().slice(0, 10),
        triggeredBy: "manual",
        runId,
      }).catch(() => { /* 错误在 emitDone 中处理 */ });

      return { code: "OK", data: { runId, async: true } };
    }

    // 其他 agent：同步执行
    const result = await agent.execute({
      tenantId: request.tenantId,
      date: new Date().toISOString().slice(0, 10),
      triggeredBy: "manual",
    });
    return { code: "OK", data: result };
  });

  // GET /agents/orchestrator/progress — 轮询执行进度
  app.get("/orchestrator/progress", async (request) => {
    const state = getRunState(request.tenantId);
    if (!state) {
      return { code: "OK", data: { running: false } };
    }
    return { code: "OK", data: { running: !state.done, ...state } };
  });

  // GET /agents/diagnostic — 系统诊断
  app.get("/diagnostic", async (request) => {
    const today = new Date().toISOString().slice(0, 10);
    const tenantId = request.tenantId;

    // 1. 今日计划
    const [plan] = await db
      .select()
      .from(dailyContentPlans)
      .where(and(eq(dailyContentPlans.tenantId, tenantId), eq(dailyContentPlans.date, today)))
      .limit(1);

    const planInfo = plan
      ? {
          id: plan.id,
          status: plan.status,
          totalArticles: plan.totalArticles,
          totalVideos: plan.totalVideos,
          taskStatuses: ((plan.tasks || []) as any[]).map((t: any) => ({ id: t.id, topic: t.topic?.slice(0, 20), status: t.status })),
        }
      : null;

    // 2. 内容表记录数
    const [contentCount] = await db
      .select({ total: sql<number>`count(*)`, reviewing: sql<number>`count(*) filter (where status = 'reviewing')`, draft: sql<number>`count(*) filter (where status = 'draft')` })
      .from(contents)
      .where(eq(contents.tenantId, tenantId));

    // 3. BullMQ 队列状态
    let queueInfo: any = {};
    try {
      const { contentQueue } = await import("../services/task/queue.js");
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        contentQueue.getWaitingCount(),
        contentQueue.getActiveCount(),
        contentQueue.getCompletedCount(),
        contentQueue.getFailedCount(),
        contentQueue.getDelayedCount(),
      ]);
      queueInfo = { waiting, active, completed, failed, delayed };

      // 获取最近失败的 job
      const failedJobs = await contentQueue.getFailed(0, 3);
      queueInfo.recentFailures = failedJobs.map((j) => ({
        id: j.id,
        name: j.name,
        failedReason: j.failedReason?.slice(0, 200),
        timestamp: j.timestamp,
      }));
    } catch (err: any) {
      queueInfo = { error: err.message };
    }

    // 4. AI Provider
    let providerInfo: any = {};
    try {
      const { getProviders } = await import("../services/ai/provider-factory.js");
      const providers = getProviders();
      providerInfo = {
        expensive: providers.expensive.map((p) => p.name),
        cheap: providers.cheap.map((p) => p.name),
      };
    } catch (err: any) {
      providerInfo = { error: err.message };
    }

    // 5. Redis
    let redisInfo: any = {};
    try {
      const { getRedisConnection } = await import("../services/task/queue.js");
      const redis = getRedisConnection();
      redisInfo = { status: redis.status };
    } catch (err: any) {
      redisInfo = { error: err.message };
    }

    return {
      code: "OK",
      data: {
        date: today,
        plan: planInfo,
        contents: contentCount,
        queue: queueInfo,
        providers: providerInfo,
        redis: redisInfo,
      },
    };
  });

  // ===== 审核 =====

  // GET /agents/review/pending
  app.get("/review/pending", async (request) => {
    const pending = await db
      .select()
      .from(contents)
      .where(
        and(
          eq(contents.tenantId, request.tenantId),
          eq(contents.status, "reviewing")
        )
      )
      .orderBy(desc(contents.createdAt))
      .limit(50);
    return { code: "OK", data: { items: pending, count: pending.length } };
  });

  // POST /agents/review/:id/approve
  app.post("/review/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [content] = await db
      .select()
      .from(contents)
      .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
      .limit(1);

    if (!content) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
    }

    await db.update(contents)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(contents.id, id));

    await db.insert(bossEdits).values({
      id: nanoid(16),
      tenantId: request.tenantId,
      contentId: id,
      action: "approve",
    });

    // 查找是否有待发布任务
    const pendingPublishes = await db
      .select()
      .from(scheduledPublishes)
      .where(
        and(
          eq(scheduledPublishes.contentId, id),
          eq(scheduledPublishes.status, "pending")
        )
      );

    if (pendingPublishes.length === 0) {
      // 没有定时发布任务，标记为 approved 等待手动发布
    }

    return { code: "OK", data: { success: true, message: "已通过审核" } };
  });

  // POST /agents/review/:id/edit
  app.post("/review/:id/edit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title, body } = request.body as { title?: string; body?: string };

    const [original] = await db
      .select()
      .from(contents)
      .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
      .limit(1);

    if (!original) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
    }

    const updates: Record<string, unknown> = { status: "approved", updatedAt: new Date() };
    if (title) updates.title = title;
    if (body) updates.body = body;
    await db.update(contents).set(updates).where(eq(contents.id, id));

    const editDistance = calculateEditDistance(original.body || "", body || original.body || "");
    await db.insert(bossEdits).values({
      id: nanoid(16),
      tenantId: request.tenantId,
      contentId: id,
      action: "edit",
      originalTitle: original.title,
      editedTitle: title || original.title,
      originalBody: original.body,
      editedBody: body || original.body,
      editDistance,
    });

    return { code: "OK", data: { success: true, message: "修改已保存" } };
  });

  // POST /agents/review/:id/reject
  app.post("/review/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    const [content] = await db
      .select()
      .from(contents)
      .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
      .limit(1);

    if (!content) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
    }

    await db.update(contents)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(contents.id, id));

    await db.insert(bossEdits).values({
      id: nanoid(16),
      tenantId: request.tenantId,
      contentId: id,
      action: "reject",
      rejectReason: reason || "",
    });

    return { code: "OK", data: { success: true, message: "已打回" } };
  });

  // ===== 自动化配置 =====

  // GET /agents/config
  app.get("/config", async (request) => {
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, request.tenantId))
      .limit(1);

    const config = (tenant?.config as Record<string, unknown>)?.automationConfig || {
      stage: "learning",
      autoPublishThreshold: 85,
      pauseThreshold: 60,
      dailyArticleLimit: 5,
      dailyVideoLimit: 5,
      focusDisciplines: [],
      enabledPlatforms: { wechat: true, baijiahao: true, toutiao: true, zhihu: true, xiaohongshu: true },
      topicBlacklist: [],
      autoUpgrade: true,
    };
    return { code: "OK", data: { config } };
  });

  // PATCH /agents/config
  app.patch("/config", async (request) => {
    const updates = request.body as Record<string, unknown>;

    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, request.tenantId))
      .limit(1);

    const currentConfig = (tenant?.config as Record<string, unknown>) || {};
    const currentAuto = (currentConfig.automationConfig as Record<string, unknown>) || {};

    currentConfig.automationConfig = { ...currentAuto, ...updates };

    await db.update(tenants)
      .set({ config: currentConfig })
      .where(eq(tenants.id, request.tenantId));

    return { code: "OK", data: { config: currentConfig.automationConfig } };
  });
}

function calculateEditDistance(a: string, b: string): number {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  let changes = 0;
  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen; i++) {
    if (linesA[i] !== linesB[i]) changes++;
  }
  return changes;
}
