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
import { desc, sql, inArray, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords as keywordsTable, contents, tenants } from "../../models/schema.js";
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
const MAX_PER_JOURNAL_24H = 1; // PR #183: 批内期刊唯一 (原 PR #135 是 2, 但一批 10 篇应 10 本不同刊)
const CANDIDATE_POOL_SIZE = 50;

// 学科 day-of-week 轮换 (0=Sun ... 6=Sat)
// 每天优先 2 个学科, fallback 时放宽到全部
// PR #173: export 给 admin 端点复用
export const DISCIPLINE_ROTATION: Record<number, string[]> = {
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
// PR #173: export 给 admin 端点复用
export async function getJournal30dCount(journalId: string): Promise<number> {
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
// PR #173: export 给 admin/generate-article 复用
export async function selectCandidates(opts: {
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

/**
 * PR #222: 读 SYSTEM 租户配置的每学科篇数 dailyQuota={medicine:3,...}。
 * 返回清洗后的正整数 map; 未配置/空 → null (回退星期轮转 + BATCH_SIZE)。
 */
export async function getDailyQuota(): Promise<Record<string, number> | null> {
  try {
    const [t] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID))
      .limit(1);
    const raw = (t?.config as { automationConfig?: { dailyQuota?: Record<string, unknown> } } | null)?.automationConfig?.dailyQuota;
    if (raw && typeof raw === "object") {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) {
        const n = Math.floor(Number(v));
        if (Number.isFinite(n) && n > 0) clean[k] = n;
      }
      if (Object.keys(clean).length > 0) return clean;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "PR #222 读 dailyQuota 失败, 回退默认");
  }
  return null;
}

export async function runDailyRecommendation(): Promise<DailyRecommendationResult> {
  const startedAt = new Date().toISOString();
  logger.info({ size: RECOMMENDATION_BATCH_SIZE }, "PR #130 daily-recommendation cron 开始");

  const dayOfWeek = new Date().getDay();
  // PR #222: 优先用配置的每学科篇数 (dailyQuota); 没配则回退星期轮转。
  const quota = await getDailyQuota();
  const todayDisciplines = quota ? Object.keys(quota) : (DISCIPLINE_ROTATION[dayOfWeek] ?? []);
  const targetTotal = quota ? Object.values(quota).reduce((a, b) => a + b, 0) : RECOMMENDATION_BATCH_SIZE;
  const poolSize = quota ? Math.max(CANDIDATE_POOL_SIZE, targetTotal * 8) : CANDIDATE_POOL_SIZE;
  const perDisc = new Map<string, number>(); // PR #222: 每学科已入队数, 用于配额封顶

  // ---- Step 1: 选候选 keywords (学科 + cooldown) ----
  let fallbackLevel = 0;
  let candidates = await selectCandidates({
    disciplines: todayDisciplines.length > 0 ? todayDisciplines : null,
    cooldownDays: KEYWORD_COOLDOWN_DAYS,
    poolSize,
  });

  // Fallback A: 学科放宽 → 全学科
  if (candidates.length < targetTotal && todayDisciplines.length > 0) {
    fallbackLevel = 1;
    logger.info({ fallbackLevel, got: candidates.length }, "PR #172 fallback A: 学科放宽到全学科");
    candidates = await selectCandidates({
      disciplines: null,
      cooldownDays: KEYWORD_COOLDOWN_DAYS,
      poolSize,
    });
  }

  // Fallback B: cooldown 放宽 30d → 14d
  if (candidates.length < targetTotal) {
    fallbackLevel = 2;
    logger.info({ fallbackLevel, got: candidates.length }, "PR #172 fallback B: cooldown 放宽到 14 天");
    candidates = await selectCandidates({
      disciplines: null,
      cooldownDays: 14,
      poolSize,
    });
  }

  // Fallback C: cooldown 放宽到 0 (无 cooldown)
  if (candidates.length < targetTotal) {
    fallbackLevel = 3;
    logger.info({ fallbackLevel, got: candidates.length }, "PR #172 fallback C: 无 cooldown");
    candidates = await selectCandidates({
      disciplines: null,
      cooldownDays: 0,
      poolSize,
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
    if (batchIds.length >= targetTotal) break;
    // PR #222: 配额模式 — 跳过不在配额内的学科 / 该学科已满额
    if (quota) {
      const cat = kw.category ?? "";
      if (!quota[cat] || (perDisc.get(cat) ?? 0) >= quota[cat]) continue;
    }

    try {
      const recs = await recommendJournals({
        tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
        topic: kw.keyword,
        limit: 5,
      });

      // PR #183: 批内期刊唯一 — 找第一个 本批未用过 且 未达 30d 限流 的 journal
      let journalId: string | null = null;
      for (const r of recs) {
        if (usedJournalIds.has(r.id)) continue; // 本批已用 → 跳过 (唯一性)
        const use24h = journalUseCount24h.get(r.id) ?? 0;
        if (use24h >= MAX_PER_JOURNAL_24H) continue;
        const use30d = await getJournal30dCount(r.id);
        if (use30d >= journalMaxPer30d) continue;
        journalId = r.id;
        break;
      }
      // 兜底: 找本批没用过的 (即使超 30d 限流), 而非强塞 recs[0] 造成批内重复
      if (!journalId) {
        journalId = recs.find((r) => !usedJournalIds.has(r.id))?.id ?? null;
      }
      // 仍无 (该 keyword top5 全被本批用过) → 跳过该 keyword, 唯一性优先于凑满 10 篇
      if (!journalId) {
        logger.debug({ keyword: kw.keyword }, "PR #183 该 keyword top5 期刊本批已全用, 跳过保唯一");
        continue;
      }

      journalUseCount24h.set(journalId, (journalUseCount24h.get(journalId) ?? 0) + 1);
      usedJournalIds.add(journalId);
      if (kw.category) usedDisciplines.add(kw.category);

      const result = await createBatch({
        tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
        userId: SYSTEM_RECOMMENDATION_USER_ID,
        filename: `daily-recommendation-${kw.keyword.slice(0, 20)}-${new Date().toISOString().slice(0, 10)}`,
        rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template: "A", priority: 3 }],
      });
      batchIds.push(result.batchId);
      if (kw.category) perDisc.set(kw.category, (perDisc.get(kw.category) ?? 0) + 1); // PR #222
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
