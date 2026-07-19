/**
 * 7-18 效果看板 — 把真实回流的 content_metrics 聚合成"证明产品价值 / 反哺选题"的分析数据。
 *
 * 复用 (红线 #11):
 *   - content_metrics 表 (roi.ts recordMetric 写入; wechat-stats-collector 回流)
 *   - "取每内容最新快照 = 累计阅读" 口径 (同 roi.ts buildRoiReport / asset-performance)
 *     —— views 列是累计快照, 不能直接跨天 SUM, 用 DISTINCT ON 取每内容最新一条。
 *   - "每日增量走 metadata.dailyReadDelta" 口径 (同 dashboard.ts totalReadsToday)
 *     —— 趋势折线用 dailyReadDelta 逐日求和 = 每日"新增"阅读。
 *
 * 反造假 (项目刚拔 8500 假数据): 全部真实聚合, 无数据的维度返回空数组 + 标记, 绝不补零/编造。
 * 空态由前端展示引导 (T+1 回流)。
 */
import { sql } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { db } from "../../models/db.js";
import { platformAccounts, journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { fillTrendZeros, computeCoverage, toDateStr, type TrendPoint } from "./effect-dashboard-utils.js";

// 纯函数从 effect-dashboard-utils.ts 复用 (单测在 effect-dashboard-utils.test.ts), 此处再导出保持 API 兼容
export { fillTrendZeros, computeCoverage };
export type { TrendPoint };

export type RangeDays = 7 | 30 | 90;

export interface EffectOverview {
  totalViews: number;
  totalShares: number;
  totalSaves: number;
  totalFollowers: number;
  totalInquiries: number;
  /** 有回流数据的内容篇数 */
  measuredCount: number;
  /** 期内已发布篇数 (content_publish_log success/published_by_operator) */
  publishedCount: number;
  /** 覆盖率 % (measured / published), 无发布记录时为 null */
  coverageRate: number | null;
  /** 数据来源拆分: API 自动回流 vs 运营手填 */
  sourceApiCount: number;
  sourceManualCount: number;
}

export interface AccountPerformance {
  accountId: string | null;
  accountName: string;
  platform: string;
  publishedCount: number; // 该号有回流数据的内容篇数
  totalViews: number;
  avgViews: number;
  maxViews: number;
}

export interface ContentRankItem {
  contentId: string;
  title: string;
  accountName: string;
  platform: string;
  views: number;
  shares: number;
  publishDate: string | null; // content.created_at (YYYY-MM-DD)
}

export interface DisciplineStat {
  discipline: string;
  count: number;
  avgViews: number;
}

export interface EffectDashboard {
  rangeDays: RangeDays;
  hasData: boolean;
  overview: EffectOverview;
  accounts: AccountPerformance[];
  ranking: ContentRankItem[];
  trend: TrendPoint[];
  disciplines: DisciplineStat[];
  /** 无回流数据的维度标记, 前端据此显示"暂无回流数据"而非 0/空白 */
  emptyDimensions: {
    accounts: boolean;
    ranking: boolean;
    trend: boolean;
    disciplines: boolean;
  };
}

// ============ 聚合主函数 ============

interface BaseRow {
  content_id: string;
  platform: string;
  views: number;
  shares: number;
  saves: number;
  followers: number;
  inquiries: number;
  source: string | null;
  account_id: string | null;
  title: string | null;
  content_created_at: string | null;
  journal_id: string | null;
}

/**
 * 效果看板聚合。全部真实 content_metrics, 取每 (content, platform) 区间内最新快照 (累计口径)。
 * @param tenantId 租户
 * @param rangeDays 7 | 30 | 90 (默认 30)
 */
export async function buildEffectDashboard(tenantId: string, rangeDays: RangeDays = 30): Promise<EffectDashboard> {
  const now = new Date();
  const sinceStr = toDateStr(new Date(now.getTime() - (rangeDays - 1) * 86400_000));

  // 1) 基表: 每内容每平台区间内最新快照 (views 累计) + 内容标题/发布日/关联期刊/回流账号/来源
  const baseRes = await db.execute(sql`
    SELECT DISTINCT ON (cm.content_id, cm.platform)
      cm.content_id, cm.platform,
      COALESCE(cm.views, 0)      AS views,
      COALESCE(cm.shares, 0)     AS shares,
      COALESCE(cm.saves, 0)      AS saves,
      COALESCE(cm.followers, 0)  AS followers,
      COALESCE(cm.inquiries, 0)  AS inquiries,
      cm.metadata->>'source'     AS source,
      cm.metadata->>'accountId'  AS account_id,
      c.title                    AS title,
      to_char(c.created_at, 'YYYY-MM-DD') AS content_created_at,
      c.metadata->>'journalId'   AS journal_id
    FROM content_metrics cm
    LEFT JOIN contents c ON c.id = cm.content_id
    WHERE cm.tenant_id = ${tenantId} AND cm.snapshot_date >= ${sinceStr}
    ORDER BY cm.content_id, cm.platform, cm.snapshot_date DESC
  `);
  const base = (((baseRes as any).rows ?? []) as any[]).map((r): BaseRow => ({
    content_id: String(r.content_id),
    platform: String(r.platform ?? ""),
    views: Number(r.views ?? 0),
    shares: Number(r.shares ?? 0),
    saves: Number(r.saves ?? 0),
    followers: Number(r.followers ?? 0),
    inquiries: Number(r.inquiries ?? 0),
    source: r.source ?? null,
    // 归一: metadata->>'accountId' 缺省=null, 但 TodayPage 手填会写空串 "" —— 空串等同"无账号",
    //   否则下游按账号分组时所有空串行会挤成一个合成账号(codex P1)。统一转 null 走平台兜底桶。
    account_id: r.account_id || null,
    title: r.title ?? null,
    content_created_at: r.content_created_at ?? null,
    journal_id: r.journal_id ?? null,
  }));

  // 2) 趋势: 逐日 dailyReadDelta 求和 (每日新增阅读) — 与 dashboard totalReadsToday 同口径
  const trendRes = await db.execute(sql`
    SELECT to_char(cm.snapshot_date, 'YYYY-MM-DD') AS d,
           COALESCE(SUM((cm.metadata->>'dailyReadDelta')::int), 0) AS reads
    FROM content_metrics cm
    WHERE cm.tenant_id = ${tenantId}
      AND cm.snapshot_date >= ${sinceStr}
      AND cm.metadata ? 'dailyReadDelta'
    GROUP BY cm.snapshot_date
  `);
  const trendRaw = (((trendRes as any).rows ?? []) as any[]).map((r) => ({
    date: String(r.d),
    reads: Number(r.reads ?? 0),
  }));
  const trend = fillTrendZeros(trendRaw, now, rangeDays);
  const hasTrendData = trendRaw.some((t) => t.reads > 0);

  // 3) 覆盖率: 期内已发布篇数 (成功群发 / 运营手动群发)
  //   窗口对齐 base/trend 的 rangeDays-1 (codex P2: 原 -rangeDays 多算一天, 覆盖率被低估)。
  //   published_by_operator 是 draft_pushed 后被 wechat-stats-collector 检测升级的, created_at 仍是草稿时间、
  //   真实发布时间在 updated_at(转移时刷新); 只按 created_at 过滤会漏掉期内实际发布的旧草稿(codex P2)。
  const pubRes = await db.execute(sql`
    SELECT COUNT(DISTINCT cpl.content_id) AS c
    FROM content_publish_log cpl
    WHERE cpl.tenant_id = ${tenantId}
      AND (
        (cpl.status = 'success' AND cpl.created_at >= (CURRENT_DATE - ${rangeDays - 1}::int))
        OR (cpl.status = 'published_by_operator' AND cpl.updated_at >= (CURRENT_DATE - ${rangeDays - 1}::int))
      )
  `);
  const publishedCount = Number((((pubRes as any).rows ?? [])[0]?.c) ?? 0);

  // ---- 账号名 / 学科 映射 (JS 端, 避免 metadata 脏值直接 ::uuid cast 报错) ----
  const accountIds = [...new Set(base.map((b) => b.account_id).filter((x): x is string => !!x))];
  const journalIds = [...new Set(base.map((b) => b.journal_id).filter((x): x is string => !!x))];

  const accMap = new Map<string, { name: string; platform: string }>();
  if (accountIds.length > 0) {
    try {
      const accRows = await db
        .select({ id: platformAccounts.id, name: platformAccounts.accountName, remark: platformAccounts.remark, platform: platformAccounts.platform })
        .from(platformAccounts)
        .where(inArray(platformAccounts.id, accountIds));
      for (const a of accRows) accMap.set(a.id, { name: a.remark || a.name || "未命名账号", platform: a.platform });
    } catch (err) {
      logger.warn({ tenantId, err: err instanceof Error ? err.message : err }, "效果看板: 账号名映射失败");
    }
  }

  const discMap = new Map<string, string>();
  if (journalIds.length > 0) {
    try {
      const jRows = await db
        .select({ id: journals.id, discipline: journals.discipline })
        .from(journals)
        .where(inArray(journals.id, journalIds));
      for (const j of jRows) if (j.discipline) discMap.set(j.id, j.discipline);
    } catch (err) {
      logger.warn({ tenantId, err: err instanceof Error ? err.message : err }, "效果看板: 学科映射失败");
    }
  }

  // 4) 总览
  let totalViews = 0, totalShares = 0, totalSaves = 0, totalFollowers = 0, totalInquiries = 0;
  let sourceApiCount = 0, sourceManualCount = 0;
  const measuredContentIds = new Set<string>();
  for (const b of base) {
    totalViews += b.views; totalShares += b.shares; totalSaves += b.saves;
    totalFollowers += b.followers; totalInquiries += b.inquiries;
    measuredContentIds.add(b.content_id);
    if (b.source === "api") sourceApiCount++;
    else sourceManualCount++; // 缺省/manual 都算手填
  }
  const measuredCount = measuredContentIds.size;

  // 5) 每账号表现
  const accAgg = new Map<string, { name: string; platform: string; views: number; count: number; max: number }>();
  for (const b of base) {
    const key = b.account_id ?? `platform:${b.platform}`;
    const meta = b.account_id ? accMap.get(b.account_id) : undefined;
    const name = meta?.name ?? (b.account_id ? "未知账号" : (b.platform || "未知来源"));
    const platform = meta?.platform ?? b.platform;
    const cur = accAgg.get(key) ?? { name, platform, views: 0, count: 0, max: 0 };
    cur.views += b.views;
    cur.count += 1;
    cur.max = Math.max(cur.max, b.views);
    accAgg.set(key, cur);
  }
  const accounts: AccountPerformance[] = [...accAgg.entries()]
    .map(([key, v]) => ({
      accountId: key.startsWith("platform:") ? null : key,
      accountName: v.name,
      platform: v.platform,
      publishedCount: v.count,
      totalViews: v.views,
      avgViews: v.count > 0 ? Math.round(v.views / v.count) : 0,
      maxViews: v.max,
    }))
    .sort((a, b) => b.totalViews - a.totalViews);

  // 6) 内容排行榜 (top 20)
  const ranking: ContentRankItem[] = [...base]
    .sort((a, b) => b.views - a.views)
    .slice(0, 20)
    .map((b) => {
      const meta = b.account_id ? accMap.get(b.account_id) : undefined;
      return {
        contentId: b.content_id,
        title: b.title || "(无标题)",
        accountName: meta?.name ?? (b.platform || "未知来源"),
        platform: b.platform,
        views: b.views,
        shares: b.shares,
        publishDate: b.content_created_at,
      };
    });

  // 7) 选题维度 (按期刊学科聚合平均阅读) — 只统计能关联到学科的内容
  const discAgg = new Map<string, { views: number; count: number }>();
  for (const b of base) {
    if (!b.journal_id) continue;
    const disc = discMap.get(b.journal_id);
    if (!disc) continue;
    const cur = discAgg.get(disc) ?? { views: 0, count: 0 };
    cur.views += b.views;
    cur.count += 1;
    discAgg.set(disc, cur);
  }
  const disciplines: DisciplineStat[] = [...discAgg.entries()]
    .map(([discipline, v]) => ({ discipline, count: v.count, avgViews: v.count > 0 ? Math.round(v.views / v.count) : 0 }))
    .sort((a, b) => b.avgViews - a.avgViews);

  const overview: EffectOverview = {
    totalViews, totalShares, totalSaves, totalFollowers, totalInquiries,
    measuredCount, publishedCount,
    coverageRate: computeCoverage(measuredCount, publishedCount),
    sourceApiCount, sourceManualCount,
  };

  return {
    rangeDays,
    hasData: measuredCount > 0,
    overview,
    accounts,
    ranking,
    trend,
    disciplines,
    emptyDimensions: {
      accounts: accounts.length === 0,
      ranking: ranking.length === 0,
      trend: !hasTrendData,
      disciplines: disciplines.length === 0,
    },
  };
}
