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
import { agentPublishTasks, contentPublishLog, contents, platformAccounts, tenants } from "../models/schema.js";
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

    const [rows, tasks, [pubCount], spend, [tenant], accounts, pubByAccount] = await Promise.all([
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
          accountId: agentPublishTasks.accountId,
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
      // PR-W3 账号发布矩阵: 全部启用账号
      db
        .select({
          id: platformAccounts.id,
          platform: platformAccounts.platform,
          accountName: platformAccounts.accountName,
        })
        .from(platformAccounts)
        .where(and(eq(platformAccounts.tenantId, tenantId), eq(platformAccounts.status, "active")))
        .orderBy(platformAccounts.platform, platformAccounts.accountName),
      // 各账号今日发布数 (publish log)
      db
        .select({
          accountId: contentPublishLog.accountId,
          count: sql<string>`COUNT(*)`,
        })
        .from(contentPublishLog)
        .where(and(eq(contentPublishLog.tenantId, tenantId), gte(contentPublishLog.createdAt, since)))
        .groupBy(contentPublishLog.accountId),
    ]);

    // 各账号今日 Agent 队列数 (pending/claimed/manual_pending 算在途)
    const queueByAccount = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === "pending" || t.status === "claimed" || t.status === "manual_pending") {
        const accId = (t as { accountId?: string }).accountId;
        if (accId) queueByAccount.set(accId, (queueByAccount.get(accId) ?? 0) + 1);
      }
    }
    const pubMap = new Map(pubByAccount.map((r) => [r.accountId, Number(r.count)]));

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
        accounts: accounts.map((a) => ({
          ...a,
          publishedToday: pubMap.get(a.id) ?? 0,
          queuedToday: queueByAccount.get(a.id) ?? 0,
        })),
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
