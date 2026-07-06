/**
 * PR-P1: 效果数据闭环 — 复用 content_metrics 表 (已存在, 字段全)。
 * 现实: 多数客户号是未认证订阅号, 微信不给数据 API → 运营手填为主;
 *       认证服务号后续可接 API 自动拉 (recordMetric 留 source 区分)。
 * 周报聚合: 本周发布数 / 总阅读 / 涨粉 / 咨询线索 / Top内容 — 续费时给老板看的 ROI。
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contentMetrics } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export interface RecordMetricInput {
  tenantId: string;
  contentId: string;
  accountId: string;
  platform: string;
  views?: number;
  likes?: number;
  shares?: number;
  saves?: number;       // 7-06 ①: 微信"收藏"(add_to_fav) — datacube 无"在看"字段, 用收藏
  followers?: number;
  inquiries?: number;
  source?: "api" | "manual";
  /** 7-06 ①: 回流写"昨日"快照时指定 (默认今天)。upsert 键 = (contentId, platform, snapshotDate) → 重跑幂等 */
  snapshotDate?: string;
  /** 7-06 ①: 平台特有指标并入 metadata (如 dailyReadDelta / msgids / matchType) */
  metadataExtra?: Record<string, unknown>;
}

/** 录入/更新一条指标 (同内容同平台同快照日 upsert — 当天多次填以最新为准) */
export async function recordMetric(input: RecordMetricInput): Promise<void> {
  const today = input.snapshotDate ?? new Date().toISOString().slice(0, 10);
  const existing = await db
    .select({ id: contentMetrics.id })
    .from(contentMetrics)
    .where(and(
      eq(contentMetrics.contentId, input.contentId),
      eq(contentMetrics.platform, input.platform),
      eq(contentMetrics.snapshotDate, today),
    ))
    .limit(1);
  const values = {
    tenantId: input.tenantId,
    contentId: input.contentId,
    platform: input.platform,
    snapshotDate: today,
    views: Math.max(0, Math.floor(input.views ?? 0)),
    likes: Math.max(0, Math.floor(input.likes ?? 0)),
    shares: Math.max(0, Math.floor(input.shares ?? 0)),
    saves: Math.max(0, Math.floor(input.saves ?? 0)),
    followers: Math.max(0, Math.floor(input.followers ?? 0)),
    inquiries: Math.max(0, Math.floor(input.inquiries ?? 0)),
    metadata: { source: input.source ?? "manual", accountId: input.accountId, ...(input.metadataExtra ?? {}) },
  };
  if (existing.length > 0) {
    await db.update(contentMetrics).set(values).where(eq(contentMetrics.id, existing[0]!.id));
  } else {
    await db.insert(contentMetrics).values(values);
  }
  logger.info({ contentId: input.contentId, views: values.views }, "PR-P1 指标已录入");
}

export interface RoiReport {
  rangeDays: number;
  publishedCount: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  totalFollowers: number;
  totalInquiries: number;
  avgViews: number;
  measuredCount: number;
  qualityCount: number;   // PR-FW: 优质文章数 (阅读 > 中位数1.5倍)
  medianViews: number;
  topContents: Array<{ contentId: string; title: string | null; views: number; platform: string }>;
}

/** ROI 周报 (默认近 7 天, 取每内容最新快照) */
export async function buildRoiReport(tenantId: string, rangeDays = 7): Promise<RoiReport> {
  const since = new Date(Date.now() - rangeDays * 86400_000).toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (cm.content_id, cm.platform)
      cm.content_id, cm.platform, cm.views, cm.likes, cm.shares, cm.followers, cm.inquiries, c.title
    FROM content_metrics cm
    LEFT JOIN contents c ON c.id = cm.content_id
    WHERE cm.tenant_id = ${tenantId} AND cm.snapshot_date >= ${since}
    ORDER BY cm.content_id, cm.platform, cm.snapshot_date DESC
  `);
  const list = ((rows as any).rows ?? []) as Array<{
    content_id: string; platform: string; views: number; likes: number;
    shares: number; followers: number; inquiries: number; title: string | null;
  }>;
  let totalViews = 0, totalLikes = 0, totalShares = 0, totalFollowers = 0, totalInquiries = 0;
  for (const r of list) {
    totalViews += r.views ?? 0; totalLikes += r.likes ?? 0; totalShares += r.shares ?? 0;
    totalFollowers += r.followers ?? 0; totalInquiries += r.inquiries ?? 0;
  }
  const measuredCount = list.length;
  // PR-FW 优质判定: 高于本批阅读中位数 1.5 倍 (相对基准, 大号小号公平)
  const sortedViews = list.map((r) => r.views ?? 0).sort((a, b) => a - b);
  const medianViews = sortedViews.length > 0 ? sortedViews[Math.floor(sortedViews.length / 2)]! : 0;
  const qualityCount = list.filter((r) => (r.views ?? 0) > medianViews * 1.5).length;
  const topContents = [...list]
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 5)
    .map((r) => ({ contentId: r.content_id, title: r.title, views: r.views ?? 0, platform: r.platform }));

  return {
    rangeDays,
    publishedCount: measuredCount,
    totalViews, totalLikes, totalShares, totalFollowers, totalInquiries,
    avgViews: measuredCount > 0 ? Math.round(totalViews / measuredCount) : 0,
    measuredCount,
    qualityCount,
    medianViews,
    topContents,
  };
}
