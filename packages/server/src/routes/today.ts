/**
 * PR-W2: 今日驾驶舱 — 老板每日工作流的统一入口。
 * GET /today 一个接口聚合:
 *   contents     今日生成的内容 (文章/视频, 含状态)
 *   agentTasks   今日本地 Agent 发布任务 (manual_pending = 等老板去浏览器点发布)
 *   publishedToday 今日发布成功条数 (content_publish_log)
 *   spend        今日/本月真实消耗 (cost_ledger) + 预算配置
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { agentPublishTasks, contentPublishLog, contents, tenants } from "../models/schema.js";
import { getSpend, type BudgetConfig } from "../services/billing/cost-ledger.js";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function todayRoutes(app: FastifyInstance) {
  app.get("/today", async (request) => {
    const tenantId = request.tenantId;
    const since = startOfToday();

    const [rows, tasks, [pubCount], spend, [tenant]] = await Promise.all([
      db
        .select({
          id: contents.id,
          type: contents.type,
          title: contents.title,
          status: contents.status,
          createdAt: contents.createdAt,
          metadata: contents.metadata,
        })
        .from(contents)
        .where(and(eq(contents.tenantId, tenantId), gte(contents.createdAt, since)))
        .orderBy(desc(contents.createdAt))
        .limit(200),
      db
        .select({
          id: agentPublishTasks.id,
          platform: agentPublishTasks.platform,
          accountName: agentPublishTasks.accountName,
          status: agentPublishTasks.status,
          error: agentPublishTasks.error,
          createdAt: agentPublishTasks.createdAt,
        })
        .from(agentPublishTasks)
        .where(and(eq(agentPublishTasks.tenantId, tenantId), gte(agentPublishTasks.createdAt, since)))
        .orderBy(desc(agentPublishTasks.createdAt))
        .limit(100),
      db
        .select({ count: sql<string>`COUNT(*)` })
        .from(contentPublishLog)
        .where(and(eq(contentPublishLog.tenantId, tenantId), gte(contentPublishLog.createdAt, since))),
      getSpend(tenantId),
      db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    ]);

    const budget: BudgetConfig =
      ((tenant?.config as { budgetConfig?: BudgetConfig } | null)?.budgetConfig) ?? {};

    return {
      code: "OK",
      data: {
        date: since.toISOString().slice(0, 10),
        contents: rows.map((r) => {
          const meta = r.metadata as { videoUrl?: string; source?: string } | null;
          return {
            id: r.id,
            type: r.type,
            title: r.title,
            status: r.status,
            createdAt: r.createdAt,
            hasVideo: !!meta?.videoUrl,
            source: meta?.source ?? null,
          };
        }),
        agentTasks: tasks,
        publishedToday: Number(pubCount?.count ?? 0),
        spend: { todayCents: spend.todayCents, monthCents: spend.monthCents },
        budget,
      },
    };
  });

  /** PUT /today/budget {dailyLimitYuan?, monthlyLimitYuan?} — 设预算 (0/空 = 不限) */
  app.put("/today/budget", async (request) => {
    const body = (request.body ?? {}) as { dailyLimitYuan?: number; monthlyLimitYuan?: number };
    const clean = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    };
    const budgetConfig: BudgetConfig = {
      dailyLimitYuan: clean(body.dailyLimitYuan),
      monthlyLimitYuan: clean(body.monthlyLimitYuan),
    };
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, request.tenantId)).limit(1);
    const config = { ...((t?.config as Record<string, unknown>) ?? {}), budgetConfig };
    await db.update(tenants).set({ config }).where(eq(tenants.id, request.tenantId));
    return { code: "OK", data: { budgetConfig } };
  });
}
