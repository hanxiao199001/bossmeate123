/**
 * PR #130（5-13 V2.5 提前）：每日推荐 cron — 全自动 10 篇 article 入 system tenant.
 *
 * 流程：
 *  1. 全 tenant 共池 SELECT top 10 keywords ORDER BY composite_score DESC, last_seen_at DESC
 *     过滤 appear_count <= 7（新鲜，不重复推老词）
 *  2. for each: 复用 PR #129 generate-article logic
 *     - P3 recommendJournals(tenantId=SYSTEM, topic=keyword) → top1 multi_source
 *     - P4 createBatch({tenantId: SYSTEM, userId: SYSTEM, ...})
 *  3. batch worker 异步跑 article-skill, contents 表 tenant_id=SYSTEM
 *  4. frontend ContentPage 切 "📅 今日推荐" tab → GET /content?recommendation=true
 *
 * Decision B: 固定 UUID system tenant 而非 NULL（contents.tenant_id NOT NULL 约束保留）。
 * 调度: scheduler.ts 注册 cron '0 3 * * *' Asia/Shanghai (每日 03:00 BJ)。
 */
import { desc, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords as keywordsTable } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { recommendJournals } from "./journal-recommender.js";
import { createBatch } from "../batch/batch-service.js";
import {
  SYSTEM_RECOMMENDATION_TENANT_ID,
  SYSTEM_RECOMMENDATION_USER_ID,
} from "../../config/system-recommendation.js";

const RECOMMENDATION_BATCH_SIZE = 10;
const FRESH_APPEAR_COUNT_MAX = 7; // 出现 ≤ 7 天 = 新鲜

export interface DailyRecommendationResult {
  selectedKeywords: number;
  articlesEnqueued: number;
  failures: Array<{ keyword: string; error: string }>;
  batchIds: string[];
  startedAt: string;
  finishedAt: string;
}

export async function runDailyRecommendation(): Promise<DailyRecommendationResult> {
  const startedAt = new Date().toISOString();
  logger.info({ size: RECOMMENDATION_BATCH_SIZE }, "PR #130 daily-recommendation cron 开始");

  // 1. SELECT top N fresh keywords (cross-tenant pool — 选高热度新鲜词)
  const candidates = await db
    .select({ id: keywordsTable.id, keyword: keywordsTable.keyword })
    .from(keywordsTable)
    .where(sql`${keywordsTable.appearCount} <= ${FRESH_APPEAR_COUNT_MAX} AND ${keywordsTable.status} = 'active'`)
    .orderBy(desc(keywordsTable.compositeScore), desc(keywordsTable.lastSeenAt))
    .limit(RECOMMENDATION_BATCH_SIZE);

  if (candidates.length === 0) {
    logger.warn("PR #130 daily-cron: 0 fresh keyword candidates (检查 keywords 抓取链路)");
    return { selectedKeywords: 0, articlesEnqueued: 0, failures: [], batchIds: [], startedAt, finishedAt: new Date().toISOString() };
  }

  const batchIds: string[] = [];
  const failures: Array<{ keyword: string; error: string }> = [];

  // PR #135 (5-12) — anti-cluster: 同 journal 24h 内最多 MAX_PER_JOURNAL 篇.
  // 用 usedJournalIds count 限流: top 1 → top 5 + 跳过已满期刊, 强制 spread 到不同期刊.
  const MAX_PER_JOURNAL = 2;
  const journalUseCount = new Map<string, number>();

  for (const kw of candidates) {
    try {
      const recs = await recommendJournals({
        tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
        topic: kw.keyword,
        limit: 5, // PR #135: 拿 top5 候选, 后面挑未饱和 journal
      });
      const journalId = recs.find((r) => (journalUseCount.get(r.id) ?? 0) < MAX_PER_JOURNAL)?.id
        ?? recs[0]?.id // 全饱和兜底（仍取 top1, 避免 enqueue 失败）
        ?? null;
      if (journalId) journalUseCount.set(journalId, (journalUseCount.get(journalId) ?? 0) + 1);

      const result = await createBatch({
        tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
        userId: SYSTEM_RECOMMENDATION_USER_ID,
        filename: `daily-recommendation-${kw.keyword.slice(0, 20)}-${new Date().toISOString().slice(0, 10)}`,
        rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template: "A", priority: 3 }],
      });
      batchIds.push(result.batchId);
      logger.debug({ keyword: kw.keyword, journalId, batchId: result.batchId, journalUseCount: journalUseCount.get(journalId ?? "") }, "PR #135 keyword enqueued (anti-cluster)");
    } catch (err) {
      const error = (err as Error).message || String(err);
      failures.push({ keyword: kw.keyword, error });
      logger.warn({ keyword: kw.keyword, err }, "PR #135 daily-cron 单 keyword 失败（跳过）");
    }
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    selectedKeywords: candidates.length,
    articlesEnqueued: batchIds.length,
    failures,
    batchIds,
    startedAt,
    finishedAt,
  };
  logger.info(summary, `PR #130 daily-recommendation cron 完成 ${batchIds.length}/${candidates.length}`);
  return summary;
}
