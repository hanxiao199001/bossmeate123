/**
 * 7-10 矩阵总览聚合 — GET /admin/matrix-overview 的数据层。
 *
 * 复用现有表，一次并发 6 条聚合查询（账号数几十的量级，直接查）：
 *   platform_accounts   账号主档（平台/名称/领域/人设/状态/绑定设备/登录态）
 *   agent_devices       设备在线判定（lastSeenAt < 90s，同 routes/accounts.ts 口径）
 *   content_publish_log 每账号：今日已发(success+published_by_operator) / 今日分发行数 /
 *                       草稿待选(draft_pushed 存量) / 最近成功发布时间
 *   agent_publish_tasks 每账号：近 24h login_expired / 今日任务数
 *   contents            今日生成数 + 待审池(needs_review)，口径同 routes/today.ts（自己租户 + SYSTEM 共享池）
 *   batch_rows          每账号今日专属生成数（PR-X1 exclusive 生成时绑定 accountId）
 *
 * 不新建表、不新建采集链路。健康判定纯函数见 matrix-health.ts。
 */
import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import {
  agentDevices,
  agentPublishTasks,
  batchRows,
  batches,
  contentPublishLog,
  contents,
  platformAccounts,
} from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import {
  computeAccountHealth,
  healthRank,
  startOfBjDay,
  type AccountHealth,
} from "./matrix-health.js";

export interface MatrixAccountRow {
  id: string;
  platform: string;
  accountName: string;
  remark: string | null;
  status: string;
  disciplines: string[];
  hasPersona: boolean;
  agentDeviceId: string | null;
  agentOnline: boolean;
  /** 今日专属生成数（batch_rows.accountId 绑定的 exclusive 生成） */
  generatedToday: number;
  /** 今日分发行数（publish log 今日新增，任意状态） */
  dispatchedToday: number;
  /** 今日已发数（success + published_by_operator） */
  publishedToday: number;
  /** 草稿箱待选数（draft_pushed 存量，推了草稿还没被运营群发） */
  draftPending: number;
  /** 最近一次成功发布时间 */
  lastSuccessAt: string | null;
  health: AccountHealth;
  healthFlags: AccountHealth[];
}

export interface MatrixOverview {
  date: string;
  summary: {
    totalAccounts: number;
    byPlatform: Record<string, number>;
    /** 今日生成内容数（租户 + SYSTEM 共享池，同今日页口径） */
    generatedToday: number;
    /** 待审池（needs_review 存量） */
    needsReview: number;
    /** 今日已发总数 */
    publishedToday: number;
    /** 草稿箱待选总数 */
    draftPending: number;
    /** 异常账号数（health 非 healthy/disabled） */
    abnormalAccounts: number;
  };
  accounts: MatrixAccountRow[];
}

export async function getMatrixOverview(
  tenantId: string,
  platform?: string,
): Promise<MatrixOverview> {
  const now = new Date();
  const since = startOfBjDay(now);
  const h24Ago = new Date(now.getTime() - 24 * 3600_000);

  const accountConds = [eq(platformAccounts.tenantId, tenantId)];
  if (platform) accountConds.push(eq(platformAccounts.platform, platform));

  const [accounts, devices, pubAgg, taskAgg, [contentAgg], exclusiveAgg] = await Promise.all([
    db
      .select({
        id: platformAccounts.id,
        platform: platformAccounts.platform,
        accountName: platformAccounts.accountName,
        remark: platformAccounts.remark,
        status: platformAccounts.status,
        loginStatus: platformAccounts.loginStatus,
        disciplines: platformAccounts.disciplines,
        persona: platformAccounts.persona,
        agentDeviceId: platformAccounts.agentDeviceId,
        createdAt: platformAccounts.createdAt,
      })
      .from(platformAccounts)
      .where(and(...accountConds))
      .orderBy(platformAccounts.platform, platformAccounts.accountName),
    db
      .select({ id: agentDevices.id, status: agentDevices.status, lastSeenAt: agentDevices.lastSeenAt })
      .from(agentDevices)
      .where(eq(agentDevices.tenantId, tenantId)),
    db
      .select({
        accountId: contentPublishLog.accountId,
        publishedToday: sql<string>`COUNT(*) FILTER (WHERE ${contentPublishLog.status} IN ('success','published_by_operator') AND ${contentPublishLog.updatedAt} >= ${since})`,
        dispatchedToday: sql<string>`COUNT(*) FILTER (WHERE ${contentPublishLog.createdAt} >= ${since})`,
        draftPending: sql<string>`COUNT(*) FILTER (WHERE ${contentPublishLog.status} = 'draft_pushed')`,
        lastSuccessAt: sql<string | null>`MAX(${contentPublishLog.updatedAt}) FILTER (WHERE ${contentPublishLog.status} IN ('success','published_by_operator'))`,
      })
      .from(contentPublishLog)
      .where(eq(contentPublishLog.tenantId, tenantId))
      .groupBy(contentPublishLog.accountId),
    db
      .select({
        accountId: agentPublishTasks.accountId,
        loginExpired24h: sql<string>`COUNT(*) FILTER (WHERE ${agentPublishTasks.status} = 'login_expired' AND ${agentPublishTasks.updatedAt} >= ${h24Ago})`,
        tasksToday: sql<string>`COUNT(*) FILTER (WHERE ${agentPublishTasks.createdAt} >= ${since})`,
      })
      .from(agentPublishTasks)
      .where(eq(agentPublishTasks.tenantId, tenantId))
      .groupBy(agentPublishTasks.accountId),
    // 今日生成 + 待审池 — 口径同 routes/today.ts（自己租户 + SYSTEM 共享推荐池）
    db
      .select({
        generatedToday: sql<string>`COUNT(*) FILTER (WHERE ${contents.createdAt} >= ${since})`,
        needsReview: sql<string>`COUNT(*) FILTER (WHERE ${contents.status} = 'needs_review')`,
      })
      .from(contents)
      .where(or(eq(contents.tenantId, tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID))),
    // 每账号今日专属生成（batch_rows.accountId 非空 = exclusive 模式绑定账号生成）
    db
      .select({
        accountId: batchRows.accountId,
        generatedToday: sql<string>`COUNT(*)`,
      })
      .from(batchRows)
      .innerJoin(batches, eq(batchRows.batchId, batches.id))
      .where(and(
        eq(batches.tenantId, tenantId),
        isNotNull(batchRows.accountId),
        gte(batchRows.createdAt, since),
      ))
      .groupBy(batchRows.accountId),
  ]);

  // 设备在线集合（同 routes/accounts.ts：active + lastSeenAt < 90s）
  const nowMs = now.getTime();
  const onlineDevs = new Set(
    devices
      .filter((d) => d.status === "active" && d.lastSeenAt && nowMs - d.lastSeenAt.getTime() < 90_000)
      .map((d) => d.id),
  );

  const pubMap = new Map(pubAgg.map((r) => [r.accountId, r]));
  const taskMap = new Map(taskAgg.map((r) => [r.accountId, r]));
  const exclusiveMap = new Map(
    exclusiveAgg.filter((r) => r.accountId).map((r) => [r.accountId as string, Number(r.generatedToday)]),
  );

  const rows: MatrixAccountRow[] = accounts.map((a) => {
    const pub = pubMap.get(a.id);
    const task = taskMap.get(a.id);
    const publishedToday = Number(pub?.publishedToday ?? 0);
    const dispatchedToday = Number(pub?.dispatchedToday ?? 0);
    const draftPending = Number(pub?.draftPending ?? 0);
    const tasksToday = Number(task?.tasksToday ?? 0);
    const lastSuccessAt = pub?.lastSuccessAt ? new Date(pub.lastSuccessAt) : null;
    const agentOnline = a.agentDeviceId ? onlineDevs.has(a.agentDeviceId) : false;

    const { health, flags } = computeAccountHealth(
      {
        accountStatus: a.status,
        loginStatus: a.loginStatus,
        agentDeviceBound: !!a.agentDeviceId,
        agentOnline,
        loginExpired24h: Number(task?.loginExpired24h ?? 0) > 0,
        lastSuccessAt,
        // 今日分到内容 = 今日 publish log 行 + 今日 agent 任务（重叠不影响 >0 判定）
        assignedToday: dispatchedToday + tasksToday,
        createdAt: a.createdAt,
      },
      since,
    );

    return {
      id: a.id,
      platform: a.platform,
      accountName: a.remark || a.accountName,
      remark: a.remark,
      status: a.status,
      disciplines: Array.isArray(a.disciplines) ? (a.disciplines as string[]) : [],
      hasPersona: !!(a.persona && a.persona.trim().length > 0),
      agentDeviceId: a.agentDeviceId,
      agentOnline,
      generatedToday: exclusiveMap.get(a.id) ?? 0,
      dispatchedToday,
      publishedToday,
      draftPending,
      lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
      health,
      healthFlags: flags,
    };
  });

  // 异常置顶（严重度升序），同级按平台/账号名稳定排序
  rows.sort((x, y) => {
    const d = healthRank(x.health) - healthRank(y.health);
    if (d !== 0) return d;
    if (x.platform !== y.platform) return x.platform.localeCompare(y.platform);
    return x.accountName.localeCompare(y.accountName, "zh-CN");
  });

  const byPlatform: Record<string, number> = {};
  for (const r of rows) byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + 1;

  return {
    date: new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10),
    summary: {
      totalAccounts: rows.length,
      byPlatform,
      generatedToday: Number(contentAgg?.generatedToday ?? 0),
      needsReview: Number(contentAgg?.needsReview ?? 0),
      publishedToday: rows.reduce((s, r) => s + r.publishedToday, 0),
      draftPending: rows.reduce((s, r) => s + r.draftPending, 0),
      abnormalAccounts: rows.filter((r) => r.health !== "healthy" && r.health !== "disabled").length,
    },
    accounts: rows,
  };
}
