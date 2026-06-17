/**
 * PR-W2: 今日驾驶舱 — 老板每日工作流的统一入口。
 * GET /today 一个接口聚合:
 *   contents     今日生成的内容 (文章/视频, 含状态)
 *   agentTasks   今日本地 Agent 发布任务 (manual_pending = 等老板去浏览器点发布)
 *   publishedToday 今日发布成功条数 (content_publish_log)
 *   spend        今日/本月真实消耗 (cost_ledger) + 预算配置
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { agentPublishTasks, contentPublishLog, contents, platformAccounts, tenants } from "../models/schema.js";
import { getSpend, type BudgetConfig } from "../services/billing/cost-ledger.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { logger } from "../config/logger.js";

/** PR-W4: "今日"按北京时间算 (服务器跑 UTC, 本地 midnight 会把今天算成昨天) */
const BJ_OFFSET_MS = 8 * 3600_000;

function startOfToday(): Date {
  const bj = new Date(Date.now() + BJ_OFFSET_MS);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - BJ_OFFSET_MS);
}

function todayDateString(): string {
  return new Date(Date.now() + BJ_OFFSET_MS).toISOString().slice(0, 10);
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
        // PR-W8: 与内容工坊同口径 — 自己租户 + 共享推荐池(每日生成进 SYSTEM 池), 否则今日页恒显示 0
        .where(and(
          or(eq(contents.tenantId, tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
          gte(contents.createdAt, since),
        ))
        .orderBy(desc(contents.createdAt))
        .limit(200),
      db
        .select({
          id: agentPublishTasks.id,
          contentId: agentPublishTasks.contentId,
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

    // 6-17 #1 发布健康: 暴露"派了却发不出"的信号。核心是 stuckPending —
    // Agent 每 15s 轮询领单, pending 超 10 分钟仍没被领 = 客户端 Agent 没开/掉线(任务石沉大海)。
    const STUCK_PENDING_MS = 10 * 60 * 1000;
    const nowMs = Date.now();
    const stuckPending = tasks.filter(
      (t) => t.status === "pending" && nowMs - new Date(t.createdAt as unknown as string).getTime() > STUCK_PENDING_MS,
    ).length;
    const loginExpired = tasks.filter((t) => t.status === "login_expired").length;
    const failedTasks = tasks.filter((t) => t.status === "failed").length;

    const budget: BudgetConfig =
      ((tenant?.config as { budgetConfig?: BudgetConfig } | null)?.budgetConfig) ?? {};

    return {
      code: "OK",
      data: {
        date: todayDateString(),
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
        agentTasks: tasks.map((t) => ({ ...t, error: t.error ? t.error.slice(0, 160) : null })),
        accounts: accounts.map((a) => ({
          ...a,
          publishedToday: pubMap.get(a.id) ?? 0,
          queuedToday: queueByAccount.get(a.id) ?? 0,
        })),
        publishedToday: Number(pubCount?.count ?? 0),
        publishHealth: { stuckPending, loginExpired, failed: failedTasks },
        spend: { todayCents: spend.todayCents, monthCents: spend.monthCents },
        budget,
        autoDistribute: (((tenant?.config as Record<string, any>)?.automationConfig)?.autoDistribute) === true,
      },
    };
  });

  /** POST /today/approve/:contentId — PR-U2 人工采用待审内容 (needs_review → generated) */
  app.post("/today/approve/:contentId", async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    const [c] = await db.select({ id: contents.id, status: contents.status })
      .from(contents)
      .where(and(eq(contents.id, contentId), or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID))))
      .limit(1);
    if (!c) return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
    if (c.status !== "needs_review") {
      return reply.code(409).send({ code: "BAD_STATUS", message: `仅待审内容可采用, 当前 ${c.status}` });
    }
    await db.update(contents).set({ status: "generated", statusUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(contents.id, contentId));
    return { code: "OK", data: { id: contentId, status: "generated" } };
  });

  /** POST /today/generate-now — PR-W8: 手动触发一次每日推荐生成 (错过 03:00 或想立即测试时用) */
  app.post("/today/generate-now", async (_request, reply) => {
    try {
      const { runDailyRecommendation } = await import("../services/recommendation/daily-cron.js");
      // fire-and-forget: 生成耗时长(每篇数秒), 立即返回, 前端轮询今日页看结果
      void runDailyRecommendation()
        .then((r) => logger.info({ enqueued: r.articlesEnqueued }, "PR-W8 手动触发每日生成完成"))
        .catch((e) => logger.error({ err: e instanceof Error ? e.message : e }, "PR-W8 手动触发每日生成失败"));
      return { code: "OK", data: { started: true } };
    } catch (err) {
      return reply.code(500).send({ code: "TRIGGER_FAILED", message: err instanceof Error ? err.message : "触发失败" });
    }
  });

  /** GET /today/asset-performance — PR-FW3 模板/形象效果榜 */
  app.get("/today/asset-performance", async (request) => {
    const { getAssetPerformance } = await import("../services/metrics/asset-performance.js");
    return { code: "OK", data: await getAssetPerformance(request.tenantId) };
  });

  /** GET /today/roi?days=7 — PR-P1 ROI 周报 */
  app.get("/today/roi", async (request) => {
    const q = (request.query ?? {}) as { days?: string };
    const days = Math.min(Math.max(Number(q.days) || 7, 1), 90);
    const { buildRoiReport } = await import("../services/metrics/roi.js");
    return { code: "OK", data: await buildRoiReport(request.tenantId, days) };
  });

  /** POST /today/metrics {contentId, accountId, platform, views, likes, shares, followers, inquiries} — PR-P1 运营手填指标 */
  app.post("/today/metrics", async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    const contentId = String(b.contentId ?? "");
    const accountId = String(b.accountId ?? "");
    const platform = String(b.platform ?? "");
    if (!contentId || !platform) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "contentId 与 platform 必填" });
    }
    const { recordMetric } = await import("../services/metrics/roi.js");
    await recordMetric({
      tenantId: request.tenantId, contentId, accountId, platform,
      views: Number(b.views) || 0, likes: Number(b.likes) || 0, shares: Number(b.shares) || 0,
      followers: Number(b.followers) || 0, inquiries: Number(b.inquiries) || 0, source: "manual",
    });
    return { code: "OK" };
  });

  /** PUT /today/automation {autoDistribute} — PR-W6 每日自动分发开关 */
  app.put("/today/automation", async (request) => {
    const body = (request.body ?? {}) as { autoDistribute?: boolean };
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, request.tenantId)).limit(1);
    const config = (t?.config as Record<string, unknown>) ?? {};
    const automationConfig = { ...((config.automationConfig as Record<string, unknown>) ?? {}), autoDistribute: body.autoDistribute === true };
    await db.update(tenants).set({ config: { ...config, automationConfig } }).where(eq(tenants.id, request.tenantId));
    return { code: "OK", data: { autoDistribute: body.autoDistribute === true } };
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
