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
import { desc, sql, inArray, eq, and, gte } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords as keywordsTable, contents, tenants, journals, journalUsage } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { startOfBjDay } from "../metrics/matrix-health.js";
import { env } from "../../config/env.js";
import { recommendJournals } from "./journal-recommender.js";
import { createBatch } from "../batch/batch-service.js";
import { generateRoundupArticle } from "../content-engine/roundup-generator.js";
import { verifiedJournalCondition, journalPoolCriteria } from "../journals/journal-sql.js";
import { getPoolInventory, disciplineCn, type PoolInventory } from "../journals/pool-inventory.js";
import { GENERIC_DISCIPLINE_CODE, DISCIPLINE_CODES } from "./discipline-mapping.js";
import { traceJournalConsumptionBatch } from "../ops/decision-trace.js";
import { classifyPickDegrade, describePickDegrade } from "./pick-degrade.js";
import { initialStatusFields } from "../articles/state-machine.js";
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

// ============ 7-28 ①a: 排产跳过点落库 ============
//
// 病根: 这个文件里有 17 个 `continue` / 早退点(学科配额满、期刊限流、选不出刊、选不出题、
//   单项生成失败…), 其中**只有 1 个**(零产出)落了 ops_incidents, 其余全是 logger 一行。
//   系统其实已经算出了"今天为什么没产出", 但这些数字只送去给人看, 而老板不看日志 ——
//   等于系统知道、没人知道。这一段把它们统一接进告警流水, 次日简报自动念出来。
//
// 节流策略(照 incidents.ts 里那条注释的分法):
//   - "一次故障连锁触发几十次"的(选刊/选题/生成失败, 每篇都会撞) → recordIncidentThrottled,
//     10 分钟一条, 被压掉的次数带在 detail.suppressedSinceLastAlert 里, 信息不丢;
//   - "一天最多一条、条数本身就是要看的量"的(零产出/产出不足/候选被跳过汇总) → recordIncident 直落。
// 铁律: 全部旁路 —— 告警链路自己挂了绝不能反过来把每日排产搞挂。
let incidentsModule: Promise<typeof import("../ops/incidents.js")> | null = null;

/** 直落一条(用于"一天至多一条"的汇总类事件)。绝不抛错。 */
async function reportCronIncident(input: {
  kind: string; message: string; severity?: "error" | "warn"; tenantId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { recordIncident } = await (incidentsModule ??= import("../ops/incidents.js"));
    await recordIncident({
      kind: input.kind, message: input.message.slice(0, 500),
      severity: input.severity ?? "warn", tenantId: input.tenantId ?? null, detail: input.detail ?? null,
    });
  } catch { /* 告警旁路, 不影响排产 */ }
}

/** 节流落一条(用于"一次故障撞几十篇"的高频跳过点)。绝不抛错。 */
function reportCronIncidentThrottled(input: {
  kind: string; message: string; severity?: "error" | "warn"; tenantId?: string | null;
  detail?: Record<string, unknown>; key: string;
}): void {
  void (async () => {
    try {
      const { recordIncidentThrottled } = await (incidentsModule ??= import("../ops/incidents.js"));
      await recordIncidentThrottled({
        kind: input.kind, message: input.message.slice(0, 500),
        severity: input.severity ?? "warn", tenantId: input.tenantId ?? null, detail: input.detail ?? null,
      }, { key: input.key });
    } catch { /* 告警旁路, 不影响排产 */ }
  })();
}

/**
 * 7-28 ①b: 产出不足的黄色线。
 * 原来只判 `totalProduced === 0` —— "目标 20 篇实际出了 1 篇"完全静默, 要等次日简报靠人眼看
 * 「今日生成 1 篇」才发现。60% 这个比例对齐简报里已有的 OPS_MIN_DAILY_CONTENT 语感:
 * 低于它算"明显不够"而不是"波动"(排产本身就有冷却/配对损耗, 卡太紧会天天黄灯变噪音)。
 */
export const LOW_OUTPUT_RATIO = 0.6;

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
  tenantId?: string;          // PR-V1: 限定租户(取 onboarding 选题池)
  sourcePlatform?: string;    // PR-V1: 限定来源(如 "onboarding")
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
  if (opts.tenantId) {
    whereClause = sql`${whereClause} AND ${keywordsTable.tenantId} = ${opts.tenantId}`;
  }
  if (opts.sourcePlatform) {
    whereClause = sql`${whereClause} AND ${keywordsTable.sourcePlatform} = ${opts.sourcePlatform}`;
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

  // 7-27 无人值守③: LLM 日花费/日调用硬上限 —— 触顶当天不再排产(宁可停产一天, 不能把余额烧光)。
  //   第二道闸在 batch-worker 逐行开工前(拦已入队的行); 客服/对话链路不经过这两处, 天然豁免。
  //   熔断事实由 llm-guard 落 ops_incidents(llm_cost_cap), 次日简报红色置顶给出人话原因。
  try {
    const { checkLlmDailyCap } = await import("../billing/llm-guard.js");
    const cap = await checkLlmDailyCap();
    if (!cap.allowed) {
      logger.error({ usage: cap.usage }, "🛑 LLM 日上限熔断 — 今日排产取消(明天北京时间零点自动解封)");
      return {
        selectedKeywords: 0,
        articlesEnqueued: 0,
        failures: [{ keyword: "(llm-cap)", error: cap.reason ?? "LLM 日上限熔断" }],
        batchIds: [],
        startedAt,
        finishedAt: new Date().toISOString(),
        fallbackLevel: 0,
        diversityStats: { uniqueJournals: 0, disciplines: [] },
      };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "LLM 日上限检查异常, 放行(fail-open)");
  }

  // 7-14 单一流水线: 退役 A 路"锁定领域号专属生成通道"。所有号(含单领域锁定号)的领域需求
  //   统一并入 computeAutoQuota 的共享池配额(见下), 不再预先绑号(exclusiveAccountId)。
  //   分发时由 smart-assign 两轮保底(领域优先 + 相邻学科兜底)从共享池匹配到号。

  // PR-O3: 配了"按类型"配额 → 走新引擎(多刊盘点+国内/国外单篇); 否则回退旧"按学科"路径。
  const contentQuota = await getContentQuota();
  if (contentQuota) {
    // 6-17 #11: 两套配额互斥, 按类型(contentQuota)优先 → 按学科(dailyQuota)被静默忽略。配了两套就告警, 防"配了不生效又不知道"。
    try {
      const dq = await getDailyQuota();
      if (dq) logger.warn({ types: Object.keys(contentQuota), disciplines: Object.keys(dq) }, "#11 同时配了按类型与按学科配额 — 按类型优先, 按学科本次被忽略");
    } catch { /* 探测性调用, 失败忽略 */ }
    logger.info({ types: Object.keys(contentQuota) }, "PR-O3 走按类型生成引擎");
    const sysResult = await runDailyContentByType(contentQuota);
    // PR-Z1 多租户隔离: 配了自己 contentQuota 的租户各自生成进自己的池 (互不共享, 客户间不撞文)
    try {
      await runTenantOwnedDailyContent();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "PR-Z1 租户自有池生成异常 (不影响系统池)");
    }
    return sysResult;
  }

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
    // 7-28 ①a: 三级 fallback 都放宽到底还是零候选 = 选题链路真的干了 —— 这天必然零产出, 直接红
    await reportCronIncident({
      kind: "no_topic_available", severity: "error",
      message: `每日排产: 候选选题为 0(已放宽到无 cooldown/全学科仍无) —— 今日必然零产出, 检查 keywords 抓取链路`,
      detail: { fallbackLevel, todayDisciplines, targetTotal },
    });
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

  // 7-28 ①a: 四个裸 continue 的计数器 —— 原来这四处一行日志都没有, 于是"候选有 50 个却只入队 3 篇"
  //   查不出是被哪一道闸吃掉的。逐条落 incident 会刷屏(候选池 50 起步), 所以计数 + 收尾汇总一条。
  const skips = { quotaFull: 0, batchDup: 0, per24h: 0, per30d: 0, allUsed: 0 };

  for (const kw of candidates) {
    if (batchIds.length >= targetTotal) break;
    // PR #222: 配额模式 — 跳过不在配额内的学科 / 该学科已满额
    if (quota) {
      const cat = kw.category ?? "";
      if (!quota[cat] || (perDisc.get(cat) ?? 0) >= quota[cat]) { skips.quotaFull++; continue; }
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
        if (usedJournalIds.has(r.id)) { skips.batchDup++; continue; } // 本批已用 → 跳过 (唯一性)
        const use24h = journalUseCount24h.get(r.id) ?? 0;
        if (use24h >= MAX_PER_JOURNAL_24H) { skips.per24h++; continue; }
        const use30d = await getJournal30dCount(r.id);
        if (use30d >= journalMaxPer30d) { skips.per30d++; continue; }
        journalId = r.id;
        break;
      }
      // 兜底: 找本批没用过的 (即使超 30d 限流), 而非强塞 recs[0] 造成批内重复
      if (!journalId) {
        journalId = recs.find((r) => !usedJournalIds.has(r.id))?.id ?? null;
      }
      // 仍无 (该 keyword top5 全被本批用过) → 跳过该 keyword, 唯一性优先于凑满 10 篇
      if (!journalId) {
        skips.allUsed++;
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

  // 7-28 ①a: 没凑够目标篇数时, 把"被哪道闸吃掉多少"一次性说清楚。
  //   达标就不报 —— 跳过本身是正常的去重机制, 只有"跳到没凑够"才是要人管的事。
  const totalSkipped = Object.values(skips).reduce((a, b) => a + b, 0);
  if (batchIds.length < targetTotal && totalSkipped > 0) {
    await reportCronIncident({
      kind: "candidate_skipped", severity: "warn",
      message: `每日排产只入队 ${batchIds.length}/${targetTotal} 篇: 学科配额满 ${skips.quotaFull} · 批内重刊 ${skips.batchDup} · 24h限流 ${skips.per24h} · 30天限流 ${skips.per30d} · top5全用完 ${skips.allUsed}`,
      detail: { skips, enqueued: batchIds.length, targetTotal, candidates: candidates.length, fallbackLevel, failures: failures.slice(0, 5) },
    });
  }
  // ①b 产出不足分级(零产出走下面 runDailyContentByType 的同名逻辑; 这条旧链路自己也要有)
  if (batchIds.length === 0) {
    await reportCronIncident({
      kind: "zero_output", severity: "error",
      message: `每日排产零入队(候选 ${candidates.length} 个全被跳过/失败)`,
      detail: { skips, failures: failures.slice(0, 5), fallbackLevel },
    });
  } else if (batchIds.length < targetTotal * LOW_OUTPUT_RATIO) {
    await reportCronIncident({
      kind: "low_output", severity: "warn",
      message: `每日排产只入队 ${batchIds.length}/${targetTotal} 篇(不足目标 ${Math.round(LOW_OUTPUT_RATIO * 100)}%)`,
      detail: { skips, enqueued: batchIds.length, targetTotal, fallbackLevel, diversityStats: summary.diversityStats },
    });
  }
  return summary;
}

// ============ PR-O3: 每日内容生成(按类型) ============
// 7-20: 加 humanities —— 国内核心刊里文史哲艺新闻类有 328 本(第二大具体学科), 原先只能塞进
//   law 桶(法学), 选出《文学评论》却按"法学"生成 = 对口度错。拆出来单独成码。
// 7-25: 原先是手抄一份 13 码副本(靠注释"保持一致"人工同步, 已经漏同步过一次) → 直接引用
//   discipline-mapping 的唯一真相源。语义一致: DISCIPLINE_CODES 只含 13 个【具体学科码】,
//   不含 generic —— 这里是"轮转生成哪些学科的内容", 综合刊(generic)只在选刊阶段兜底, 不作生成目标。
const ALL_DISC_CODES: readonly string[] = DISCIPLINE_CODES;

/**
 * 学科轮转偏移（8-17 修）。
 *
 * ## 原来它从不轮转
 *
 * ```ts
 * const discipline = discs[i % discs.length];   // i 只到 count-1
 * ```
 *
 * `count = 4`、`discs.length = 13` → `i % 13` 恒取 0,1,2,3，
 * 而且**每天都从 i=0 重新开始** —— 于是永远只用
 * `medicine / education / economics / engineering`，
 * `computer` 及其后 9 个学科**一次都轮不到**（8-17 实测：近 4 天全库只有
 * education 56 / generic 44 / medicine 12 被碰过，其余 0）。
 * "轮转"这个名字是假的。
 *
 * 改成按**日**推进：今天从第 dayOfYear 个学科起排，明天顺延。
 *
 * ## ⚠️ 它与学科配额各管各的，别混为一谈
 *
 * · **轮转**决定「今天优先试哪些学科」（顺序）
 * · **配额**决定「每个学科最多耗几本刊」（上限）
 *
 * 两者不冲突：轮转把机会均摊出去，配额防止某个学科被吃干。
 * 下一个人若把其中一个当成另一个，会得出"配了轮转就不用配额"这种错结论。
 */
export function rotationOffsetForDay(now: Date = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 86_400_000);
  return dayOfYear;
}

/** 取今日第 i 个槽位该用的学科 —— 纯函数, 便于"连续 30 天每个学科都轮到"这类断言 */
export function disciplineForSlot(discs: readonly string[], i: number, now: Date = new Date()): string {
  if (discs.length === 0) return GENERIC_DISCIPLINE_CODE;
  return discs[(rotationOffsetForDay(now) + i) % discs.length]!;
}



// 7-30: 冷却天数不再在这里各读一遍 env —— 单一真相源是 journal-sql.ts 的 journalCooldownDays()
//   (选刊器的 fresh 条件、盘点服务的余量估算都从那里取, 保证"15 天"只有一个定义)。

/** PR-Z1: 给每个配了自己 contentQuota 的租户生成自有内容池 */
async function runTenantOwnedDailyContent(): Promise<void> {
  const { users } = await import("../../models/schema.js");
  const allTenants = await db.select({ id: tenants.id, config: tenants.config }).from(tenants);
  for (const t of allTenants) {
    if (t.id === SYSTEM_RECOMMENDATION_TENANT_ID) continue;
    const raw = (t.config as { automationConfig?: { contentQuota?: Record<string, { count?: number; disciplines?: string[] }> } } | null)
      ?.automationConfig?.contentQuota;
    if (!raw || typeof raw !== "object") continue;
    const clean: Record<string, { count: number; disciplines: string[] }> = {};
    for (const [k, v] of Object.entries(raw)) {
      const count = Math.floor(Number(v?.count)) || 0;
      if (count > 0) clean[k] = { count, disciplines: Array.isArray(v?.disciplines) ? v!.disciplines.map(String) : [] };
    }
    if (Object.keys(clean).length === 0) continue;
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, t.id)).limit(1);
    if (!u) continue;
    try {
      const r = await runDailyContentByType(clean, { tenantId: t.id, userId: u.id });
      logger.info({ tenantId: t.id, enqueued: r.articlesEnqueued }, "PR-Z1 租户自有池生成完成");
    } catch (err) {
      logger.error({ tenantId: t.id, err: err instanceof Error ? err.message : err }, "PR-Z1 租户自有池生成失败 (跳过)");
    }
  }
}

/** 读 SYSTEM 租户的 contentQuota(按类型配额)。空/未配 → null。 */
/** 6-20 账号-内容自动配齐: 从活跃公众号的 定位(国内/国外/两者)+领域 反推该生成多少国内/国外+哪些学科。
 *  保证每个账号都有对口内容; 账号变多也不用手动算配额。轮询选学科(i%len)天然覆盖各学科。 */
export async function computeAutoQuota(): Promise<Record<string, { count: number; disciplines: string[] }> | null> {
  try {
    const { platformAccounts } = await import("../../models/schema.js");
    const accts = await db.select({
      journalScope: platformAccounts.journalScope,
      disciplines: platformAccounts.disciplines,
      discipline: platformAccounts.discipline,
    }).from(platformAccounts).where(and(eq(platformAccounts.platform, "wechat"), eq(platformAccounts.status, "active")));
    if (accts.length === 0) return null;
    const discOf = (a: { disciplines: unknown; discipline: string | null }): string[] => {
      const ds = Array.isArray(a.disciplines) && (a.disciplines as string[]).length ? (a.disciplines as string[]) : (a.discipline ? [a.discipline] : []);
      return ds.filter(Boolean);
    };
    // 7-14 单一流水线: 退役 A 路后, 所有活跃号(含单领域"锁定"号)统一并入共享池配额, 不再有专属生成。
    //   每类型(国内/国外)生成量 = 覆盖该范围所有号保底所需(号数 × 下限 × 缓冲);
    //   学科分布按"号数"加权(教育号多 → 多生成教育文, 避免"10 篇全生物、教育号没货")。
    let domCount = 0, intlCount = 0;
    const domW = new Map<string, number>(), intlW = new Map<string, number>(); // 学科 → 覆盖它的号数
    const bump = (m: Map<string, number>, ds: string[]) => { for (const d of ds) m.set(d, (m.get(d) ?? 0) + 1); };
    for (const a of accts) {
      const scope = a.journalScope || "both";
      const ds = discOf(a);
      if (scope === "domestic" || scope === "both") { domCount++; bump(domW, ds); }
      if (scope === "international" || scope === "both") { intlCount++; bump(intlW, ds); }
    }
    // 生成量 = 号数 × 保底下限 × 缓冲(分配损耗留量), 每类型封顶 min(30, 硬上限)。
    const target = Math.max(1, Math.floor(env.DRAFT_TARGET_PER_ACCOUNT));
    const buffer = Math.max(1, Number(env.DRAFT_GEN_BUFFER) || 1);
    const perTypeCap = Math.min(30, Math.max(1, Math.floor(env.DAILY_GEN_HARD_CAP)));
    const scale = (n: number) => Math.min(perTypeCap, Math.max(0, Math.ceil(n * target * buffer)));
    // 学科加权数组: 每学科按覆盖它的号数重复, runDailyContentByType 轮询(i%len)天然按号数比例生成。
    //   (仅"领域不限"号的范围 → 该范围 map 为空 → 回退 ALL_DISC_CODES 均匀轮转。)
    const weighted = (m: Map<string, number>): string[] => {
      const out: string[] = [];
      for (const [d, n] of m) for (let i = 0; i < n; i++) out.push(d);
      return out;
    };
    const q: Record<string, { count: number; disciplines: string[] }> = {};
    if (domCount > 0) q.domestic = { count: scale(domCount), disciplines: weighted(domW) };
    if (intlCount > 0) q.international = { count: scale(intlCount), disciplines: weighted(intlW) };
    return Object.keys(q).length > 0 ? q : null;
  } catch (err) { logger.warn({ err: String(err) }, "computeAutoQuota 失败"); return null; }
}

export async function getContentQuota(): Promise<Record<string, { count: number; disciplines: string[] }> | null> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    // 6-20: 开了"按账号自动配齐"→ 用账号定位反推配额(忽略手动篇数); 没账号则回退手动配置。
    if ((t?.config as { automationConfig?: { autoQuotaFromAccounts?: boolean } } | null)?.automationConfig?.autoQuotaFromAccounts === true) {
      const aq = await computeAutoQuota();
      if (aq) {
        // 7-20 修 roundup 归零: computeAutoQuota 只按账号定位推 domestic/international,
        //   不含 roundup(多刊盘点不绑账号定位, 是独立内容形态)。7-19 开自动配齐后 roundup
        //   直接从 2 篇/天掉到 0 停产。这里把手配的 roundup 并回来 —— 账号能推的用推的,
        //   推不出来的(roundup)沿用运营手配值, 不硬编码篇数。
        const manual = (t?.config as { automationConfig?: { contentQuota?: Record<string, { count?: number; disciplines?: string[] }> } } | null)?.automationConfig?.contentQuota;
        const rc = Math.floor(Number(manual?.roundup?.count)) || 0;
        if (rc > 0) aq.roundup = { count: rc, disciplines: Array.isArray(manual?.roundup?.disciplines) ? manual!.roundup!.disciplines!.map(String) : [] };
        logger.info({ quota: aq }, "6-20 用账号自动配齐配额(7-20: roundup 沿用手配值)");
        return aq;
      }
    }
    const raw = (t?.config as { automationConfig?: { contentQuota?: Record<string, { count?: number; disciplines?: string[] }> } } | null)?.automationConfig?.contentQuota;
    if (raw && typeof raw === "object") {
      const clean: Record<string, { count: number; disciplines: string[] }> = {};
      for (const [k, v] of Object.entries(raw)) {
        const count = Math.floor(Number(v?.count)) || 0;
        if (count > 0) clean[k] = { count, disciplines: Array.isArray(v?.disciplines) ? v!.disciplines.map(String) : [] };
      }
      if (Object.keys(clean).length > 0) return clean;
    }
  } catch (err) { logger.warn({ err: String(err) }, "PR-O3 读 contentQuota 失败"); }
  return null;
}

// 7-28 (#1) 未核实探索日配额: conf<70/legacy_unknown 刊生成的内容会被 batch-worker 标 needs_review
//   (人工复核积压), 所以未核实新鲜池只能细水长流 —— 每租户每天最多 N 篇, env UNVERIFIED_DAILY_QUOTA
//   可配(默认 2, 设 0 = 关闭探索层)。计数走当日 journal_usage×journals 联查(进程重启/多实例不丢数);
//   生成失败回滚删 usage 行会自动释放当日配额。
const UNVERIFIED_DAILY_QUOTA = (() => {
  const n = Number(process.env.UNVERIFIED_DAILY_QUOTA);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();
async function unverifiedUsedToday(tenantId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` })
    .from(journalUsage)
    .innerJoin(journals, eq(journalUsage.journalId, journals.id))
    .where(and(
      eq(journalUsage.tenantId, tenantId),
      // 8-02 🔴 由 `date_trunc('day', now())` 改为 startOfBjDay()。
      //   病症: DB session 时区是 UTC, `date_trunc('day', now())` 给的是 **UTC 零点 = BJ 08:00**,
      //   于是"今日已用"的窗口变成 BJ 08:00 → 次日 08:00。而生成跑在 BJ 03:00, 正落在窗口尾部 ——
      //   它把**昨天 08:00 之后**的用量算成今天, 探索额度提前用满, 可用的未核实刊被白白跳过。
      //   实测(8-02 16:48): 这句算出"今日已用 = 0", 而真实 BJ 今日 = 30 —— 窗口整个错位。
      //   改用 drizzle 类型化比较 + startOfBjDay(): 类型化比较对 NAIVE/TZ 两类列都正确
      //   (journal_usage.used_at 是 TZ), 且不必在这里记住该表是哪一种。
      gte(journalUsage.usedAt, startOfBjDay()),
      // 与 verification.ts 的 isUnverifiedJournal 同口径(7-28 起是**分体系**门槛:
      //   国内刊看目录成员资格, 国际刊看 conf>=70) —— 两边必须同源, 否则配额会把
      //   "已核实的国内刊"也算进探索额度, 白白吃掉每日 2 个名额。
      sql`NOT ${verifiedJournalCondition()}`,
    ));
  return r?.n ?? 0;
}

/** 选一本 定位+学科 的刊。7-28 (#1) 层序重排, 铁律: **新鲜(15天冷却)优先于回头(LRU)** ——
 *  冷却是产品承诺, 回头刊只能是最后手段; 未核实新鲜池按日配额小口放行(其内容会转 needs_review, 配额挡积压):
 *  ①② 已核实+新鲜(对口→泛学科generic) → ③④ 未核实+新鲜(对口→泛学科, 日配额内)
 *  → ⑤⑥ 已核实 LRU 回头刊(对口→泛学科) → ⑦-⑩ 产量红线 floor(已核实池整体为空才会走到:
 *  全池新鲜→全池LRU→丢学科新鲜→全放开LRU, 不受配额限制, 宁发未核实/不对口也不空名额)。
 *  修复动机: 旧层②(已核实+对口, LRU **无 fresh 条件**)只要 verified 对口池非空必然短路返回 ——
 *  小学科 verified 池(如 5 本)新鲜耗尽后天天 LRU 回头同几本, 旧⑤-⑧ 永远到不了,
 *  15 天冷却形同虚设("国际刊反复就那几本"的主因)。 */
async function pickScopedFreshJournal(
  tenantId: string,
  scope: string,
  discipline: string,
  /**
   * 🔴 留痕上下文。**不传 = requestedBy 记成 unknown** —— 那正是"漏接的路径"的信号。
   *   留痕装在选刊器内部而不是调用点, 就是为了让漏接可见: 只在调用点接的话,
   *   没接的路径不会留下任何痕迹, 于是分不清"这条路没跑"还是"跑了没记"。
   */
  traceCtx?: { requestedBy: import("../ops/decision-trace.js").RequestedBy },
): Promise<string | null> {
  const { traceJournalIntent } = await import("../ops/decision-trace.js");
  const correlationId = await traceJournalIntent({
    requestedBy: traceCtx?.requestedBy ?? "unknown",
    slotDiscipline: discipline,
    scope,
    tenantId,
  });
  void correlationId; // consumption 侧按 journalId 关联(本轮不串 id, 见文件头口径)
  // 7-30 条件片段收口: active / verified / sc / discExact / discOrGeneric / fresh 六个片段
  //   全部取自 journal-sql.ts 的 journalPoolCriteria() —— 与「期刊池盘点」
  //   (services/journals/pool-inventory.ts, 回答"这个学科还剩几本可选")**同一份 WHERE**。
  //   为什么必须同源: 盘点若另写一套条件, 算出的"余量"和选刊器实际能选到的不是同一批刊,
  //   报表会说"还有 20 本"而选刊器一本都选不出 —— 比没有盘点更糟。这个项目已因"照着再写一遍"
  //   犯过 5 次同类错(病史见 journals/intl-signal.ts 文件头)。
  //   各片段自身的历史与权衡(6-19 排编造刊 / 7-09 未核实护栏 / 7-20 学科码归一 /
  //   7-21 分层收窄 / 7-28 分体系门槛)已随片段一起搬进 journal-sql.ts 的注释, 不在此重复。
  const { active, verified, scope: sc, discExact, discOrGeneric, fresh } =
    journalPoolCriteria({ tenantId, scope, discipline });
  // 去冷却的层级按"最久未用"优先, 保证轮换(而非反复用同几本)
  const lru = sql`(SELECT max(ju.used_at) FROM journal_usage ju WHERE ju.journal_id = ${journals.id} AND ju.tenant_id = ${tenantId}) ASC NULLS FIRST`;
  const rnd = sql`random()`;
  const pick = async (conds: Array<unknown>, order: unknown): Promise<string | null> => {
    const cs = conds.filter(Boolean) as Parameters<typeof and>;
    const [j] = await db.select({ id: journals.id }).from(journals).where(and(...cs)).orderBy(order as any).limit(1);
    return j?.id ?? null;
  };
  // 分层(命中即返回)。6-19 修"国外槽位漏国内刊": 每一层都绝不丢 scope —— 只放宽 学科/可信度/冷却,
  // 国内/国外定位始终保留。
  // ①② 已核实+新鲜: 对口(discExact) → 泛学科(discOrGeneric)。教育号优先吃教育刊, 学科枯竭才吃综合刊。
  const freshVerified = (await pick([active, verified, sc, discExact, fresh], rnd))
    ?? (await pick([active, verified, sc, discOrGeneric, fresh], rnd));
  if (freshVerified) return freshVerified;
  // ③④ 未核实+新鲜(日配额内): 已核实新鲜池枯竭时小口探索新刊 —— 其内容会被 batch-worker 标
  //   needs_review 人工复核, 配额(默认 2/天)防止把"重复"换成"积压"。
  if (UNVERIFIED_DAILY_QUOTA > 0 && (await unverifiedUsedToday(tenantId)) < UNVERIFIED_DAILY_QUOTA) {
    const freshUnverified = (await pick([active, sc, discExact, fresh], rnd))
      ?? (await pick([active, sc, discOrGeneric, fresh], rnd));
    if (freshUnverified) {
      logger.info({ scope, discipline, quota: UNVERIFIED_DAILY_QUOTA }, "选刊: 已核实新鲜池枯竭, 日配额内放行未核实新鲜刊(内容将转 needs_review 复核)");
      return freshUnverified;
    }
  }
  // ⑤⑥ 已核实 LRU 回头刊(最后手段, 打破15天冷却但数据可信): 对口 → 泛学科。
  const lruVerified = (await pick([active, verified, sc, discExact], lru))
    ?? (await pick([active, verified, sc, discOrGeneric], lru));
  if (lruVerified) { logger.info({ scope, discipline }, "选刊: 新鲜池全枯竭(含未核实配额), 回退已核实 LRU 回头刊(15天内重复, 最后手段)"); return lruVerified; }
  // ⑦⑧ 产量红线 floor: 走到这说明该 scope 下已核实池整体为空(如国内小学科), 放开可信度保名额
  //   (不受日配额限制 —— 配额只管"有已核实备选时别贪新", 没有备选时保产量优先)。
  const byGeneric = (await pick([active, sc, discOrGeneric, fresh], rnd))
    ?? (await pick([active, sc, discOrGeneric], lru));
  if (byGeneric) { logger.warn({ scope, discipline }, "选刊: 已核实池为空, 回退未核实综合池兜底(将转 needs_review)"); return byGeneric; }
  // ⑨⑩ 保产量最后两层: 学科+综合刊都枯竭, 仅按 scope 选(宁不对口不空名额, 草稿池饿死比不对口更糟)
  const byScope = (await pick([active, sc, fresh], rnd))
    ?? (await pick([active, sc], lru));
  if (byScope) logger.warn({ scope, discipline }, "选刊: 学科+综合刊池均枯竭, 仅按 scope 兜底(内容可能不对口)");
  return byScope;
}

/** 按 contentQuota 逐类型生成(多刊盘点 + 国内核心/国外期刊单篇)。数字人暂不自动。 */
/**
 * PR-Q2 模板多元+智能: 在真·排版模板间按「模板效果」加权轮换(无数据均匀)。阅读高的权重高 → 越用越智能。
 *
 * ## 🔴 8-13 收口：可选集不再本地写死，改问 registry
 *
 * 原来这里有一份本地白名单(PR-Q7 只放 顺仕美途 + 故事叙述)，
 * 与 `article-skill` 的 `pickRotatingTemplateId()`（从全部已注册模板挑）**各判各的**。
 * 后果：PR-Q7 那条限制只管住了本文件这条链路，而 article-skill 链路从未受它约束 ——
 * 近 14 天 130 篇 popular-science / industry-vertical / data-card 就是从那儿出来的。
 * 在任一处关掉一个模板，另一处随时把它捞回来。
 *
 * 现在「能不能被自动挑中」只有一处定义：`TemplateDefinition.rotationEnabled`。
 * **本函数只保留它真正独有的东西 —— 效果加权**（唯一连着效果数据的部分）。
 *
 * ⚠️ 行为变更：可选集由 2 个变为 registry 里 rotationEnabled 的全部。
 *   8-13 实测复核推翻了 PR-Q7 的旧评估（详见 commit）。
 */
async function buildTemplateWeights(tenantId: string): Promise<Record<string, number>> {
  const { listRotatableTemplates } = await import("../skills/template-registry.js");
  const rotatable = listRotatableTemplates().map((t) => t.id);
  const w: Record<string, number> = Object.fromEntries(rotatable.map((t) => [t, 1]));
  try {
    const { getAssetPerformance } = await import("../metrics/asset-performance.js");
    const { templates } = await getAssetPerformance(tenantId);
    if (templates.length > 0) {
      const avgAll = templates.reduce((s, t) => s + t.avgViews, 0) / templates.length;
      if (avgAll > 0) {
        for (const t of templates) {
          if (t.key in w) w[t.key] = Math.max(0.5, t.avgViews / avgAll); // 相对均值, 低分留探索机会
        }
      }
    }
  } catch { /* 无数据均匀 */ }
  return w;
}
function pickTemplateId(weights: Record<string, number>): string {
  // 候选集来自 weights 的键(buildTemplateWeights 已按 rotationEnabled 过滤) —— 两件事各归其位:
  //   enabled 过滤(registry 唯一归宿) → 效果加权挑选(本函数)
  const keys = Object.keys(weights);
  if (keys.length === 0) return "shunshi-style";
  const total = keys.reduce((s, t) => s + (weights[t] ?? 1), 0);
  let r = Math.random() * total;
  for (const t of keys) { r -= weights[t] ?? 1; if (r <= 0) return t; }
  return keys[0]!;
}

/**
 * 7-30 感知①: **排产前**的期刊池预判。
 *
 * 此前系统只有事后归因(`classifyPickDegrade`: 选完看它是不是回头刊/不对口刊)。事后归因是对的,
 * 但它回答不了"今天会不会出事" —— 而这个事实其实排产前就已经确定: 某学科新鲜已核实池 = 0、
 * 今天却还要给它排 3 篇, 那这 3 篇**注定**要降级。把它记在降级发生之前, 运营才有机会当天补货。
 *
 * ⚠️ 这一轮**刻意不用它改变排产行为**(不跳过、不改配额、不换学科) —— 那是下一步"决策"的事。
 *   感知与决策混在一起做, 两件都做不干净: 一个估算口径还没被生产数据验证过的模型, 不该立刻拿去
 *   决定今天发不发内容。这里只做到"知道 + 报出来"。
 *
 * 绝不抛错: 观测失败当作没盘点(返回 null), 不能因为一次统计查询把每日排产打挂。
 */
async function preflightJournalPool(
  tenantId: string,
  cq: Record<string, { count: number; disciplines: string[] }>,
): Promise<Record<string, unknown> | null> {
  let inv: PoolInventory;
  try {
    inv = await getPoolInventory({ tenantId });
  } catch (err) {
    logger.warn({ err: String(err) }, "7-30 排产前期刊池盘点失败(跳过预判, 不影响排产)");
    return null;
  }
  try {
    // 今天真要排的 (定位 × 学科) 名额数 —— 与下面主循环 `discs[i % discs.length]` 同一个分配算法
    const planned: Array<{ scope: "domestic" | "international"; discipline: string; slots: number }> = [];
    for (const [type, cfg] of Object.entries(cq)) {
      if (type !== "domestic" && type !== "international") continue;
      const count = Math.floor(Number(cfg?.count)) || 0;
      if (count <= 0) continue;
      const discs = cfg.disciplines.length ? cfg.disciplines : ALL_DISC_CODES;
      const per = new Map<string, number>();
      for (let i = 0; i < count; i++) {
        const d = discs[i % discs.length];
        per.set(d, (per.get(d) ?? 0) + 1);
      }
      for (const [discipline, slots] of per) planned.push({ scope: type, discipline, slots });
    }
    const byKey = new Map(inv.rows.map((r) => [`${r.disciplineCode}|${r.scope}`, r]));
    const doomed: Array<Record<string, unknown>> = [];
    const tight: Array<Record<string, unknown>> = [];

    for (const p of planned) {
      const row = byKey.get(`${p.discipline}|${p.scope}`);
      if (!row) continue;
      const fact = {
        scope: p.scope, discipline: p.discipline, slots: p.slots,
        freshVerified: row.freshVerified, genericFreshVerified: row.genericFreshVerified,
        verified: row.verified, total: row.total, exhaustedInDays: row.exhaustedInDays,
      };
      if (row.freshVerified <= 0) {
        doomed.push(fact);
        const scopeCn = p.scope === "domestic" ? "国内核心" : "国际刊";
        // kind 与事后的 journal_pool_exhausted **刻意分开**: 那条是"已经降级了"的实锤,
        //   这条是"开工前就注定要降级"的预警。合成一个的话预警会被实锤的计数吞掉。
        reportCronIncidentThrottled({
          kind: "journal_pool_forecast", severity: "warn", tenantId,
          message:
            `期刊池预判[${scopeCn}·${disciplineCn(p.discipline)}]: 今天要排 ${p.slots} 篇, 而该学科可选新刊 0 本` +
            `(已核实共 ${row.verified} 本, 全在 ${inv.cooldownDays} 天冷却内; 综合刊还剩 ${row.genericFreshVerified} 本垫底)` +
            ` —— 这几篇注定要降级(重复用刊或串到综合刊), 需补该学科期刊或调低配额`,
          detail: { tenantId, phase: "pre_schedule", ...fact, cooldownDays: inv.cooldownDays },
          key: `pool_forecast:${tenantId}:${p.scope}:${p.discipline}`,
        });
      } else if (row.low) {
        tight.push(fact);
      }
    }
    if (doomed.length > 0 || tight.length > 0) {
      logger.warn({ doomed, tight }, "7-30 排产前期刊池预判: 有学科池已空/接近水位线");
    }
    return {
      cooldownDays: inv.cooldownDays, usageWindowDays: inv.usageWindowDays,
      plannedSlots: planned.reduce((n, p) => n + p.slots, 0),
      doomed, tight,
      alertDisciplines: inv.alerts.slice(0, 5).map((r) => ({
        discipline: r.disciplineCode, scope: r.scope,
        freshVerified: r.freshVerified, exhaustedInDays: r.exhaustedInDays,
      })),
      invisibleUnknown: inv.invisibleUnknown,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "7-30 排产前期刊池预判失败(不影响排产)");
    return null;
  }
}

export async function runDailyContentByType(
  cq: Record<string, { count: number; disciplines: string[] }>,
  // PR-Z1 多租户隔离: 指定目标租户则内容落到该租户自己的池 (默认 SYSTEM 全局池, 向后兼容)
  target?: { tenantId: string; userId: string },
): Promise<DailyRecommendationResult> {
  const startedAt = new Date().toISOString();
  const SYS = target?.tenantId ?? SYSTEM_RECOMMENDATION_TENANT_ID;
  const SYS_USER = target?.userId ?? SYSTEM_RECOMMENDATION_USER_ID;
  const tplWeights = await buildTemplateWeights(SYS); // PR-Q2 模板加权
  const batchIds: string[] = [];
  const failures: Array<{ keyword: string; error: string }> = [];
  let roundupCount = 0;
  const uniqueJournals = new Set<string>();
  const usedDisc = new Set<string>();
  // 7-28 ①b: 目标 = 各类型 cfg.count 之和。原来这个数根本没被算出来过 —— 于是"目标 20 实际 1"
  //   与"目标 1 实际 1"在日志里长得一模一样, 只有零产出才有告警。
  const targetTotal = Object.values(cq).reduce((n, c) => n + (Math.floor(Number(c?.count)) || 0), 0);
  // 7-28 ①a: 名额是怎么蒸发的(选不出题/选不出刊), 收尾时一并带进告警 detail
  const skipped = { noTopic: 0, noJournal: 0 };
  // 7-30 感知①: 排产**之前**先盘一次期刊池, 把"今天注定要降级"记在降级发生之前(见下)
  const poolPreflight = await preflightJournalPool(SYS, cq);

  for (const [type, cfg] of Object.entries(cq)) {
    if (!cfg.count) continue;
    const discs = cfg.disciplines.length ? cfg.disciplines : ALL_DISC_CODES;
    for (let i = 0; i < cfg.count; i++) {
      const discipline = disciplineForSlot(discs, i);
      usedDisc.add(discipline);
      try {
        if (type === "roundup") {
          const { title, html, journalCovers, journalIds } = await generateRoundupArticle({ tenantId: SYS, discipline, count: 3, audience: "普通院校教师" });
          // 7-25: 盘点补编造闸。此前 roundup 是**唯一一条零校验产线** —— 既不过 checkCompliance,
          //   也没有编造检测(它不走 batch-worker / quality-pipeline, 那两处的闸门够不着),
          //   而它每天在产、又是"一次说 3 本刊的 IF/分区"的最高危形态。
          //   多刊没有单一 journalId → 用 journalIds 全集做并集判定(见 checkRoundupFabrication)。
          const { checkRoundupFabrication, checkCompliance: checkComplianceRoundup } = await import("../compliance/content-check.js");
          const fab = await checkRoundupFabrication({ title, body: html, journalIds });
          const comp = await checkComplianceRoundup(`${title}\n${html}`);
          const roundupOk = fab.ok && !comp.blocked;
          if (!roundupOk) {
            logger.warn({ discipline, journalIds, mismatches: fab.mismatches, hardHits: comp.hardHits }, "7-25 盘点编造/合规命中, 转 needs_review");
          }
          const [row] = await db.insert(contents).values({
            tenantId: SYS, userId: SYS_USER, type: "article", title, body: html,
            // 多刊盘点是成品文章, 直接 generated 进批量发布(原误存 draft 导致进不了内容工坊批量导入)
            ...initialStatusFields(roundupOk ? "generated" : "needs_review"),
            metadata: {
              source: "roundup", templateId: "journal-roundup", discipline, journalCovers,
              // 7-25: 落 journalIds —— 发布期闸门(draft-distributor / publishToAccounts)靠它
              //   才能查到本篇涉及哪些刊; 原来只存 journalCovers, 发布侧一律当"无期刊"放行。
              journalIds,
              ...(roundupOk ? {} : {
                needsReview: true,
                needsReviewReason: fab.ok ? "compliance" : "body_fabrication",
                ...(fab.mismatches.length ? { bodyFabrication: fab.mismatches } : {}),
              }),
            },
          }).returning({ id: contents.id });
          if (row?.id && journalIds.length) {
            await db.insert(journalUsage).values(journalIds.map((jid) => ({ tenantId: SYS, journalId: jid, contentId: row.id })));
            // 留痕: **一本刊一行**(roundup 一篇用 3 本 = 3 行)
            void traceJournalConsumptionBatch(journalIds, {
              requestedBy: "daily_cron_roundup", slotDiscipline: discipline, scope: "roundup",
              tenantId: SYS, contentId: row.id,
            });
            journalIds.forEach((jid) => uniqueJournals.add(jid));
          }
          roundupCount++;
        } else if (type === "topicPool") {
          // PR-V1 跨行业最后一公里: 从本租户 onboarding 选题池取题, 通用生成(不挂期刊)
          const cands = await selectCandidates({
            disciplines: null, cooldownDays: 7, poolSize: 5,
            tenantId: SYS, sourcePlatform: "onboarding",
          });
          const pick = cands[0];
          if (!pick) {
            logger.info({ tenantId: SYS }, "PR-V1 选题池无可用新题, 跳过");
            // 7-28 ①a: 这个 continue 原来只有 info 一行 —— 选题池空掉 = 该类型天天静默零产,
            //   而"我配了 topicPool 却没出内容"是运营最容易一头雾水的场景。
            skipped.noTopic++;
            reportCronIncidentThrottled({
              kind: "no_topic_available", severity: "warn", tenantId: SYS,
              message: `选题池无可用新题(onboarding 池 7 天冷却内全用过) — topicPool 类型本次跳过`,
              detail: { tenantId: SYS, type, discipline },
              key: `no_topic:${SYS}`,
            });
            continue;
          }
          const { generateByFormat } = await import("../content-engine/format-generators.js");
          const gen = await generateByFormat({
            tenantId: SYS, userId: SYS_USER, topic: pick.keyword, format: "article",
          });
          // P0四件套(7-03): ④压缩→③去AI腔→①六维质检+定向重写闭环, 失败兜底用原文(绝不阻塞每日生成)
          let finalBody = gen.body;
          let qpMeta: Record<string, unknown> = {};
          let sixDimFail = false;
          try {
            const { runArticleQualityPasses, qualityPipelineMeta } = await import("../content-engine/quality-pipeline.js");
            const qp = await runArticleQualityPasses({ tenantId: SYS, userId: SYS_USER, title: gen.title, body: gen.body });
            finalBody = qp.body;
            qpMeta = qualityPipelineMeta(qp);
            sixDimFail = qp.qualityLoop.passed === false;
          } catch (e) { logger.warn({ e }, "P0四件套流水线失败(topicPool, 非阻塞)"); }
          // PR-U2 轻量质检: 字数下限 + 合规硬词; P0① 六维未过同样转 needs_review(人工看低分)
          const { checkCompliance, checkTitleBodyConsistency, checkTitleDataConsistency } = await import("../compliance/content-check.js");
          const comp = await checkCompliance(`${gen.title}\n${finalBody}`);
          const plainLen = (finalBody || "").replace(/<[^>]+>/g, "").length;
          // 7-03/7-05 标题-正文一致性: ①风险信号 vs 保录承诺(行7) ②标题审稿/录用率数字正文无据(行1) → needs_review
          const tbc = checkTitleBodyConsistency(gen.title, finalBody);
          const tdc = checkTitleDataConsistency(gen.title, finalBody);
          if (!tbc.ok) logger.warn({ topic: pick.keyword, ...tbc }, "标题-正文矛盾, 转 needs_review");
          if (!tdc.ok) logger.warn({ topic: pick.keyword, mismatches: tdc.mismatches }, "标题数字正文无据, 转 needs_review");
          const qcPass = plainLen >= 300 && !comp.blocked && !sixDimFail && tbc.ok && tdc.ok;
          const [row] = await db.insert(contents).values({
            tenantId: SYS, userId: SYS_USER, type: "article",
            title: gen.title, body: finalBody,
            ...initialStatusFields(qcPass ? "generated" : "needs_review"),
            metadata: { source: "topic_pool", topic: pick.keyword, needsReview: !qcPass, ...gen.metadata, ...qpMeta },
          }).returning({ id: contents.id });
          if (row?.id) batchIds.push(row.id);
          await db.update(keywordsTable).set({ lastRecommendedAt: new Date() }).where(eq(keywordsTable.id, pick.id));
        } else if (type === "domestic" || type === "international") {
          const journalId = await pickScopedFreshJournal(SYS, type, discipline, { requestedBy: "daily_cron_article" });
          if (!journalId) {
            logger.info({ type, discipline }, "PR-O3 该范围无可用新刊, 跳过");
            // 7-28 ①a: 十层兜底都选不出刊 = 该定位+学科的池子是空的, 这个名额直接蒸发。
            //   原来只有一行 info, 于是"配了 8 篇国内医学只出了 3 篇"没有任何可查的痕迹。
            skipped.noJournal++;
            reportCronIncidentThrottled({
              kind: "no_journal_available", severity: "warn", tenantId: SYS,
              message: `选不出可用期刊[${type}·${discipline}](十层兜底全空) — 该名额空转, 需补该学科期刊或调整配额`,
              detail: { tenantId: SYS, type, discipline },
              key: `no_journal:${SYS}:${type}:${discipline}`,
            });
            continue;
          }
          // 7-28 ①a: 选到了, 但是**怎么选到的**? 破冷却的回头刊 / 不对口刊 = 该学科刊快用完了。
          //   必须在写 journal_usage 占位行之前判, 否则刚写的那行会把自己算成"回头刊"(见 pick-degrade.ts)。
          const degrade = await classifyPickDegrade(SYS, journalId, discipline);
          if (degrade.degraded) {
            logger.warn({ type, discipline, journalId, ...degrade }, "7-28 选刊降级到第⑤层以下");
            reportCronIncidentThrottled({
              kind: "journal_pool_exhausted", severity: "warn", tenantId: SYS,
              message: describePickDegrade(type, discipline, degrade),
              detail: { tenantId: SYS, type, discipline, journalId, ...degrade },
              key: `journal_pool:${SYS}:${type}:${discipline}`,
            });
          }
          const cands = await selectCandidates({ disciplines: [discipline], cooldownDays: 0, poolSize: 5 });
          const topic = cands[0]?.keyword ?? discipline;
          const result = await createBatch({
            tenantId: SYS, userId: SYS_USER,
            filename: `daily-${type}-${discipline}-${new Date().toISOString().slice(0, 10)}`,
            rows: [{ rowIndex: 1, topic, journalId, templateId: pickTemplateId(tplWeights), template: "A", priority: 3 }],
          });
          batchIds.push(result.batchId);
          uniqueJournals.add(journalId);
          // 7-28 (#5): 这行是**占位冷却**(入队时 content 还没生成, contentId 只能为空)。
          //   batch-worker 生成成功后会把近 2 天窗口内的占位行回填 contentId; 生成彻底失败的回滚
          //   也只删 2 天窗口内 contentId 为空的行 —— 不再一次失败清光该刊全部历史冷却。
          await db.insert(journalUsage).values({ tenantId: SYS, journalId });
          void traceJournalConsumptionBatch([journalId], {
            requestedBy: "daily_cron_article", slotDiscipline: discipline, scope: type, tenantId: SYS,
          });
          if (cands[0]) await db.update(keywordsTable).set({ lastRecommendedAt: new Date() }).where(eq(keywordsTable.id, cands[0].id));
        }
      } catch (err) {
        const error = (err as Error).message || String(err);
        failures.push({ keyword: `${type}/${discipline}`, error });
        logger.warn({ type, discipline, err }, "PR-O3 单项生成失败(跳过)");
        // 7-28 ①a: 生成失败原来只 warn 一行。一次故障会连撞几十篇(AI 挂/额度没了), 走节流,
        //   被压掉的次数带在 detail.suppressedSinceLastAlert 里, 不会把别的告警淹掉。
        reportCronIncidentThrottled({
          kind: "generation_failed", severity: "warn", tenantId: SYS,
          message: `单篇生成失败[${type}·${discipline}]: ${error.slice(0, 200)}`,
          detail: { tenantId: SYS, type, discipline, error: error.slice(0, 300) },
          key: `gen_failed:${SYS}:${type}`,
        });
      }
    }
  }
  const totalProduced = batchIds.length + roundupCount;
  // 7-28 ①a/①b: 运行事实(目标/实际/失败/名额蒸发)一并带进告警 detail —— 这正是"今天为什么
  //   没产出"要的全部字段。scheduler 那边只 logger.info 就丢了, 落进 incident.detail 至少
  //   在次日简报里点得开(轻表 pipeline_runs 见交接清单的下一步)。
  const runFacts = {
    tenant: SYS, types: Object.keys(cq), targetTotal, totalProduced,
    articles: batchIds.length, roundup: roundupCount,
    skipped, failures: failures.slice(0, 5), failureCount: failures.length,
    uniqueJournals: uniqueJournals.size, disciplines: [...usedDisc],
    // 7-30 感知①: 排产前就已知的期刊池余量 —— 追问"今天为什么重复/不对口"时,
    //   这一段能直接回答"因为开工前该学科就只剩 0 本", 而不用再去反推。
    poolPreflight,
  };
  // 8-02 🔴 这里**不再落 zero_output / low_output**。
  //
  // 原因: totalProduced = batchIds.length + roundupCount = **入队数**, 不是生成数
  //   (createBatch 只是 db.insert, 真正的生成在下游 batch-worker 异步跑)。
  //   本函数 03:00 跑完时一篇都还没生成 —— 在这里判"产出"必然判的是意图不是结果。
  //   实测代价: 近 14 天 batch_rows 失败 416/成功 526, 而这两条 incident 一条都没落过。
  //   欠费/AI 挂掉恰恰长这样: 入队照常成功, 下游全军覆没, 告警一片绿。
  //
  // 改到简报侧(09:30, 那时当天批次早跑完)按**实际生成的 contents 条数**判:
  //   ops/generation-outcome.ts + daily-briefing.collectOutcomeItems。
  //   那里还多一条 generation_pipeline_unhealthy(batch_rows 自比 failed/total > 20%),
  //   正是本洞的直接守卫 —— 入队 617 行只出 219 篇, 以后会自己喊出来。
  //
  // 日志保留: 它是**入队环节**的即时信号(给技术看), 措辞改成如实说"入队"。
  if (totalProduced === 0) {
    logger.error({ ...runFacts }, "⚠️ 每日排产一行都没入队! 查期刊冷却/候选词/配额。真实产出由简报侧结果闭环判定");
  } else if (targetTotal > 0 && totalProduced < targetTotal * LOW_OUTPUT_RATIO) {
    logger.warn({ ...runFacts }, `⚠️ 每日排产入队不足: ${totalProduced}/${targetTotal} 行(真实产出由简报侧结果闭环判定)`);
  }
  logger.info({ roundupCount, articles: batchIds.length, failures: failures.length, totalProduced, targetTotal }, "PR-O3 每日内容(按类型)生成完成");
  return {
    selectedKeywords: batchIds.length, articlesEnqueued: totalProduced,
    failures, batchIds, startedAt, finishedAt: new Date().toISOString(),
    fallbackLevel: 0, diversityStats: { uniqueJournals: uniqueJournals.size, disciplines: [...usedDisc] },
  };
}
