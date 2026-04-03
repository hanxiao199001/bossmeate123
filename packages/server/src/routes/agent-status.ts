/**
 * Agent 系统 API 路由
 * - Agent 状态查询
 * - 每日计划查询
 * - 内容审核（approve/edit/reject）
 * - 自动化配置
 */

import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { agentRegistry } from "../services/agents/base/registry.js";
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

  // POST /agents/:name/trigger — 手动触发
  app.post("/:name/trigger", async (request, reply) => {
    const { name } = request.params as { name: string };
    const agent = agentRegistry.get(name);
    if (!agent) {
      return reply.code(404).send({ code: "NOT_FOUND", message: `Agent "${name}" not found` });
    }

    const result = await agent.execute({
      tenantId: request.tenantId,
      date: new Date().toISOString().slice(0, 10),
      triggeredBy: "manual",
    });
    return { code: "OK", data: result };
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
      dailyArticleLimit: 20,
      dailyVideoLimit: 5,
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
