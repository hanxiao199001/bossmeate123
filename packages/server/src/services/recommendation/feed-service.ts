/**
 * PR #133 V2.5 Day 1 (5-12): 推荐 feed 数据层.
 *
 * 主流程 (RecommendationFeedPage 用):
 *  1. SELECT contents WHERE tenant_id = SYSTEM_RECOMMENDATION_TENANT_ID
 *  2. LEFT JOIN journals ON c.metadata->>'journalId' (用 jsonb 拿期刊元数据)
 *  3. 过滤 status='generated' + created_at within last 7 days (新鲜)
 *  4. 排除 user 已 skip 的 (LEFT JOIN user_skip_log)
 *  5. ORDER BY journal.confidence DESC NULLS LAST, c.created_at DESC
 *  6. LIMIT (default 10)
 *
 * Decision 3 (5-11 锁): 卡片封面用 journals.coverImageUrl + fallback emoji (前端处理).
 */
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { logger } from "../../config/logger.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FRESH_WINDOW_DAYS = 7;

export interface RecommendationItem {
  id: string;
  title: string | null;
  body: string | null;
  status: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  journal: {
    id: string;
    name: string | null;
    nameEn: string | null;
    impactFactor: number | null;
    partition: string | null;
    confidence: number | null;
    coverImageUrl: string | null;
  } | null;
}

export interface FetchRecommendationsInput {
  /** user 自己的 tenantId — 用于 LEFT JOIN user_skip_log 过滤已 skip */
  userTenantId: string;
  limit?: number;
  skipFiltered?: boolean;
}

export async function fetchRecommendations(input: FetchRecommendationsInput): Promise<{ items: RecommendationItem[]; total: number }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const skipFiltered = input.skipFiltered ?? true;

  // jsonb metadata->>'journalId' 取出 uuid + LEFT JOIN journals + 可选 user_skip_log 排除
  const skipJoin = skipFiltered
    ? sql`LEFT JOIN user_skip_log usl ON usl.content_id = c.id AND usl.tenant_id = ${input.userTenantId}::uuid`
    : sql``;
  const skipFilter = skipFiltered ? sql`AND usl.content_id IS NULL` : sql``;

  const rows = await db.execute(sql`
    SELECT
      c.id, c.title, c.body, c.status, c.created_at AS "createdAt", c.metadata,
      j.id AS "journalId", j.name AS "journalName", j.name_en AS "journalNameEn",
      j.impact_factor AS "impactFactor", j.partition AS "partition",
      j.confidence AS "confidence", j.cover_image_url AS "coverImageUrl"
    FROM contents c
    LEFT JOIN journals j ON j.id = NULLIF(c.metadata->>'journalId', '')::uuid
    ${skipJoin}
    WHERE c.tenant_id = ${SYSTEM_RECOMMENDATION_TENANT_ID}::uuid
      -- 老韩 6-15: 纳入 needs_review, 让待审内容也进工坊批量发布(发布时合规层兜底); 前端按 status 标'待审'
      AND c.status IN ('generated', 'needs_review')
      AND c.created_at > NOW() - INTERVAL '${sql.raw(`${FRESH_WINDOW_DAYS} days`)}'
      -- 5-23 PR #162: filter 有 body-level fact warnings 的 (validator 标 hasWarnings=true)
      -- IS DISTINCT FROM 处理 NULL: 老文章无该字段 → NULL → NOT 'true' = 留, 新文章命中 warnings → 排除
      AND (c.metadata->>'hasWarnings' IS DISTINCT FROM 'true')
      ${skipFilter}
    ORDER BY j.confidence DESC NULLS LAST, c.created_at DESC
    LIMIT ${limit}
  `);

  // drizzle execute returns { rows } or array; normalize
  const rawRows = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []);

  const items: RecommendationItem[] = rawRows.map((r) => ({
    id: r.id as string,
    title: r.title as string | null,
    body: r.body as string | null,
    status: r.status as string,
    createdAt: (r.createdAt instanceof Date ? r.createdAt.toISOString() : (r.createdAt as string)),
    metadata: r.metadata as Record<string, unknown> | null,
    journal: r.journalId
      ? {
          id: r.journalId as string,
          name: r.journalName as string | null,
          nameEn: r.journalNameEn as string | null,
          impactFactor: r.impactFactor as number | null,
          partition: r.partition as string | null,
          confidence: r.confidence as number | null,
          coverImageUrl: r.coverImageUrl as string | null,
        }
      : null,
  }));

  logger.debug({ userTenantId: input.userTenantId, limit, returned: items.length }, "PR #133 fetchRecommendations");
  return { items, total: items.length };
}
