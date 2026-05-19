/**
 * PR #130（5-13 V2.5 提前）：每日推荐 cron — 全自动 10 篇 article 入 system tenant.
 *
 * PR #172 改造：3 层去重 + 学科轮换
 *  - Layer 1: keyword 30 天 cooldown (last_recommended_at)
 *  - Layer 2: journal 30 天 ≤ 5 篇限流
 *  - Layer 3: 学科 day-of-week 轮换 (保留 PR #135 anti-cluster 24h ≤ 2)
 *  - Fallback: 学科放宽 → cooldown 放宽 → 限流放宽
 *
 * 流程：
 *  1. 按今日学科 + cooldown 选候选 keywords
 *  2. for each: recommendJournals top5 + journal 30d 限流
 *  3. createBatch 入队
 *  4. UPDATE keyword.last_recommended_at
 *
 * 调度: scheduler.ts 注册 cron '0 3 * * *' Asia/Shanghai (每日 03:00 BJ)。
 */
import { desc, sql, inArray } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords as keywordsTable, contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { recommendJournals } from "./journal-recommender.js";
import { createBatch } from "../batch/batch-service.js";
import {
  SYSTEM_RECOMMENDATION_TENANT_ID,
  SYSTEM_RECOMMENDATION_USER_ID,
} from "../../config/system-recommendation.js";

const RECOMMENDATION_BATCH_SIZE = 10;
const FRESH_APPEAR_COUNT_MAX = 7;

// PR #172: 多样性常量
const KEYWORD_COOLDOWN_DAYS = 30;
const JOURNAL_MAX_PER_30D = 5;
const MAX_PER_JOURNAL_24H = 2; // PR #135 anti-cluster 保留
const CANDIDATE_POOL_SIZE = 50;

// 学科 day-of-week 轮换 (0=Sun ... 6=Sat)
// 每天优先 2 个学科, fallback 时放宽到全部
const DISCIPLINE_ROTATION: Record<number, string[]> = {
  1: ["psychology", "education"],        // 周一
  2: ["medicine", "biology"],            // 周二
  3: ["engineering", "computer"],         // 周三
  4: ["economics", "law"],               // 周四
  5: ["agriculture", "environment"],      // 周五
  6: ["chemistry", "physics"],            // 周六
  0: [],                                  // 周日: 全学科 (补漏)
};

export interface DailyRecommendationResult {
  selectedKeywords: number;
  articlesEnqueued: number;
  failures: Array<{ keyword: string; error: string }>;
  batchIds: string[];
  startedAt: string;
  finishedAt: string;
  fallbackLevel: number; // PR #172: 0=无 fallback, 1=学科放宽, 2=cooldown 放宽, 3=限流放宽
  diversityStats: { uniqueJournals: number; disciplines: string[] };
}

/**
 * PR #172: 查 journal 最近 30 天在 SYSTEM tenant 的 contents 数量
 */
async function getJournal30dCount(journalId: string): Promise<number> {
  const rows = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(contents)
    .where(sql`${contents.tenantId} = ${SYSTEM_RECOMMENDATION_TENANT_ID}
      AND ${contents.metadata}->>'journalId' = ${journalId}
      AND ${contents.createdAt} >= NOW() - INTERVAL '30 days'`);
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * PR #172: 选候选 keywords (cooldown + 学科 + 新鲜度)
 */
async function selectCandidates(opts: {
  disciplines: string[] | null; // null = 全学科
  cooldownDays: number;
  poolSize: number;
}): Promise<Array<{ id: string; keyword: string; category: string | null }>> {
  const { disciplines, cooldownDays, poolSize } = opts;

  // 构建 WHERE 条件
  let whereClause = sql`${keywordsTable.appearCount} <= ${FRESH_APPEAR_COUNT_MAX}
    AND ${keywordsTable.status} = 'active'
    AND (${keywordsTable.lastRecommendedAt} IS NULL
         OR ${keywordsTable.lastRecommendedAt} < NOW() - INTERVAL '${sql.raw(String(cooldownDays))} days')`;

  if (disciplines && disciplines.length > 0) {
    whereClause = sql`${whereClause} AND ${keywordsTable.category} IN (${sql.join(disciplines.map(d => sql`${d}`), sql`, `)})`;
  }

  return db
    .select({
      id: keywordsTable.id,
      keyword: keywordsTable.keyword,
      category: keywordsTable.category,
    })
    .from(keywordsTable)
    .where(whereClause)
    .orderBy(desc(keywordsTable.compositeScore), desc(keywordsTable.lastSeenAt))
    .limit(poolSize);
}

export async function runDailyRecommendation(): Promise<DailyRecommendationResult> {
  const startedAt = new Date().toISOString();
  logger.info({ size: RECOMMENDATION_BATCH_SIZE }, "PR #130 daily-recommendation cron 开始");

  const dayOfWeek = new Date().getDay();
  const todayDisciplines = DISCIPLINE_ROTATION[dayOfWeek] ?? [];

  // ---- Step 1: 选候选 keywords (学科 + cooldown) ----
  let fallbackLevel = 0;
  let candidates = await selectCandidates({
    disciplines: todayDisciplines.length > 0 ? todayDisciplines : null,
    cooldownDays: KEYWORD_COOLDOWN_DAYS,
    poolSize: CANDIDATE_POOL_SIZE,
  });

  // Fallback A: 学科放宽 → 全学科
  if (candidates.length < RECOMMENDATION_BATCH_SIZE && todayDisciplines.length > 0) {
    fallbackLevel = 1;
    logger.info({ fallbackLevel, got: candidates.length }, "PR #172 fallback A: 学科放宽到全学科");
    candidates = await selectCandidates({
      disciplines: null,
      cooldownDays: KEYWORD_COOLDOWN_DAYS,
      poolSize: CANDIDATE_POOL_SIZE,
    });
  }

  // Fallback B: cooldown 放宽 30d → 14d
  if (candidates.length < RECOMMENDATION_BATCH_SIZE) {
    fallbackLevel = 2;
    logger.info({ fallbackLevel, got: candidates.length }, "PR #172 fallback B: cooldown 放宽到 14 天");
    candidates = await selectCandidates({
      disciplines: null,
      cooldownDays: 14,
      poolSize: CANDIDATE_POOL_SIZE,
    });
  }

  // Fallback C: cooldown 放宽到 0 (无 cooldown)
  if (candidates.length < RECOMMENDATION_BATCH_SIZE) {
    fallbackLevel = 3;
    logger.info({ fallbackLevel, got: candidates.length }, "PR #172 fallback C: 无 cooldown");
    candidates = await selectCandidates({
      disciplines: null,
      cooldownDays: 0,
      poolSize: CANDIDATE_POOL_SIZE,
    });
  }

  if (candidates.length === 0) {
    logger.warn("PR #130 daily-cron: 0 fresh keyword candidates (检查 keywords 抓取链路)");
    return {
      selectedKeywords: 0, articlesEnqueued: 0, failures: [], batchIds: [],
      startedAt, finishedAt: new Date().toISOString(),
      fallbackLevel, diversityStats: { uniqueJournals: 0, disciplines: [] },
    };
  }

  // ---- Step 2: 逐候选过 journal 限流, 攒够 10 ----
  const batchIds: string[] = [];
  const failures: Array<{ keyword: string; error: string }> = [];
  const selectedKeywordIds: string[] = [];
  const journalUseCount24h = new Map<string, number>(); // PR #135 保留
  const usedJournalIds = new Set<string>();
  const usedDisciplines = new Set<string>();
  let journalMaxPer30d = JOURNAL_MAX_PER_30D;

  // Fallback: 如果 fallbackLevel >= 3, 期刊限流也放宽
  if (fallbackLevel >= 3) journalMaxPer30d = 10;

  for (const kw of candidates) {
    if (batchIds.length >= RECOMMENDATION_BATCH_SIZE) break;

    try {
      const recs = await recommendJournals({
        tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
        topic: kw.keyword,
        limit: 5,
      });

      // 找第一个 未达 24h 限流 且 未达 30d 限流 的 journal
      let journalId: string | null = null;
      for (const r of recs) {
        const use24h = journalUseCount24h.get(r.id) ?? 0;
        if (use24h >= MAX_PER_JOURNAL_24H) continue;
        const use30d = await getJournal30dCount(r.id);
        if (use30d >= journalMaxPer30d) continue;
        journalId = r.id;
        break;
      }
      // 全饱和兜底: 仍取 top1
      if (!journalId) journalId = recs[0]?.id ?? null;

      if (journalId) {
        journalUseCount24h.set(journalId, (journalUseCount24h.get(journalId) ?? 0) + 1);
        usedJournalIds.add(journalId);
      }
      if (kw.category) usedDisciplines.add(kw.category);

      const result = await createBatch({
        tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
        userId: SYSTEM_RECOMMENDATION_USER_ID,
        filename: `daily-recommendation-${kw.keyword.slice(0, 20)}-${new Date().toISOString().slice(0, 10)}`,
        rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template: "A", priority: 3 }],
      });
      batchIds.push(result.batchId);
      selectedKeywordIds.push(kw.id);
      logger.debug({ keyword: kw.keyword, journalId, batchId: result.batchId }, "PR #172 keyword enqueued");
    } catch (err) {
      const error = (err as Error).message || String(err);
      failures.push({ keyword: kw.keyword, error });
      logger.warn({ keyword: kw.keyword, err }, "PR #172 daily-cron 单 keyword 失败（跳过）");
    }
  }

  // ---- Step 3: 更新 keyword.last_recommended_at ----
  if (selectedKeywordIds.length > 0) {
    await db
      .update(keywordsTable)
      .set({ lastRecommendedAt: new Date() })
      .where(inArray(keywordsTable.id, selectedKeywordIds));
    logger.info({ count: selectedKeywordIds.length }, "PR #172 keywords.last_recommended_at 已更新");
  }

  const finishedAt = new Date().toISOString();
  const summary: DailyRecommendationResult = {
    selectedKeywords: selectedKeywordIds.length,
    articlesEnqueued: batchIds.length,
    failures,
    batchIds,
    startedAt,
    finishedAt,
    fallbackLevel,
    diversityStats: {
      uniqueJournals: usedJournalIds.size,
      disciplines: Array.from(usedDisciplines),
    },
  };
  logger.info(summary, `PR #172 daily-cron 完成 ${batchIds.length}/${candidates.length} (fallback=${fallbackLevel}, journals=${usedJournalIds.size})`);
  return summary;
}
