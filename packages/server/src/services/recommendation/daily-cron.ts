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
import { desc, sql, inArray, eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords as keywordsTable, contents, tenants, journals, journalUsage } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { recommendJournals } from "./journal-recommender.js";
import { createBatch } from "../batch/batch-service.js";
import { generateRoundupArticle } from "../content-engine/roundup-generator.js";
import { journalScopeCondition, verifiedJournalCondition } from "../journals/journal-sql.js";
import { DISCIPLINE_CODES, GENERIC_DISCIPLINE_CODE } from "./discipline-mapping.js";
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

const JOURNAL_COOLDOWN_DAYS = Number(process.env.JOURNAL_REUSE_COOLDOWN_DAYS) || 15;

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
      sql`${journalUsage.usedAt} >= date_trunc('day', now())`,
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
async function pickScopedFreshJournal(tenantId: string, scope: string, discipline: string): Promise<string | null> {
  // 6-19 数据质量护栏: 排除 ai_fabricated(生成时 LLM 编造、IF/分区/录用率是假的)刊, 不让它们进每日生成。
  //   只排这一类: 正经的低可信/目录刊(国内核心常 confidence 为空)仍保留, 不误杀。
  const active = and(eq(journals.status, "active"), sql`(${journals.dataSource} IS DISTINCT FROM 'ai_fabricated')`);
  // 7-09 未核实护栏: 优先取已核实刊生成内容(避免用 legacy_unknown/低可信刊生成对外内容);
  //   verified 池枯竭再回退原逻辑, 保证每日篇数不因严选而空名额。
  // 7-28 分体系门槛(③c): 原来一刀切 `confidence >= 70`, 而 trust-score 的加分项全是国际源
  //   (crossref+20/doaj+10/letpub+20) —— 国内刊的天花板恰好是"进北大核心或CSCD核心库=70",
  //   只在CSCD扩展库=60, 两个目录都不在=50, **永远过不了线** → 88% 国内刊在 SQL 层就被挡住
  //   (实测 verified 427/3707, 综合性人文社科 0/122, 中国政治 0/43 —— 整个学科推不出一本刊),
  //   于是国内槽位天天靠 ⑦⑧ 兜底层选刊, 内容还全被标 needs_review。
  //   现在改判: 国内刊看**目录成员资格 + 刊号实体确认**, 国际刊维持 conf>=70(见 journal-sql.ts)。
  const verified = verifiedJournalCondition();
  const sc = journalScopeCondition(scope); // SQL | null
  // 7-20 学科码归一(migration 026): 原本 `discipline ILIKE '%medicine%'` 匹配不上国内刊的
  //   中文分类名("临床医学"/"外科学"), 国内 verified 刊只有 137/2379 能进这一层。改打生成列
  //   discipline_code 后 2379 本全可进。
  // 7-21 分层收窄(修"generic 桶淹没目标学科"): 原 disc 是 `= discipline OR = generic`,
  //   一层里目标学科与综合刊平权随机选。但 generic 桶(328本, 多是理工医综合刊)远大于单个学科池,
  //   导致教育号配了 education(132本)却 80% 选到理工综合刊(实测教育对口率仅 29%)。
  //   改: 先只选**目标学科对口刊**(discExact), 对口刊+相邻枯竭再放开 generic 兜底。
  //   generic '综合刊/学报/规则未覆盖'仍在任何学科槽位可命中, 只是降到"目标学科不够时才用"。
  const discExact = sql`(${journals.disciplineCode} = ${discipline})`;
  const discOrGeneric = sql`(${journals.disciplineCode} = ${discipline} OR ${journals.disciplineCode} = ${GENERIC_DISCIPLINE_CODE})`;
  const fresh = sql`NOT EXISTS (SELECT 1 FROM journal_usage ju WHERE ju.journal_id = ${journals.id} AND ju.tenant_id = ${tenantId} AND ju.used_at > NOW() - make_interval(days => ${JOURNAL_COOLDOWN_DAYS}))`;
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
// PR-Q2 模板多元+智能: 在 4 个真·排版模板间按"模板效果"加权轮换(无数据均匀)。
// data-card/storytelling/listicle/shunshi-style 各有不同 HTML 生成器→真视觉多元; 阅读高的权重高→越用越智能。
// PR-Q7: 自动轮换暂只用已审过的顺仕美途(其余3个有硬伤: 故事裸标签/数据卡片超时/曾崩溃, 修好再放回)。
// 用户仍可在"排版样式"下拉手动选其余模板测试/修复。
// 6-19: 放回 storytelling(其裸标签 bug 已修, 见 task#7); data-card(超时)/listicle(曾崩溃)待复核再放。
const LAYOUT_TEMPLATES = ["shunshi-style", "storytelling"] as const;
async function buildTemplateWeights(tenantId: string): Promise<Record<string, number>> {
  const w: Record<string, number> = Object.fromEntries(LAYOUT_TEMPLATES.map((t) => [t, 1]));
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
  const total = LAYOUT_TEMPLATES.reduce((s, t) => s + (weights[t] ?? 1), 0);
  let r = Math.random() * total;
  for (const t of LAYOUT_TEMPLATES) { r -= weights[t] ?? 1; if (r <= 0) return t; }
  return "shunshi-style";
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

  for (const [type, cfg] of Object.entries(cq)) {
    if (!cfg.count) continue;
    const discs = cfg.disciplines.length ? cfg.disciplines : ALL_DISC_CODES;
    for (let i = 0; i < cfg.count; i++) {
      const discipline = discs[i % discs.length];
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
          const journalId = await pickScopedFreshJournal(SYS, type, discipline);
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
  };
  if (totalProduced === 0) {
    // 零产出告警: 别再静默停摆几天没人发现。失败明细一并打出, 便于定位(余额/冷却/候选枯竭)。
    logger.error({ ...runFacts }, "⚠️ 每日生成零产出! 请检查 LLM 余额 / 期刊冷却 / 候选词。详见 failures");
    // 7-25 运维告警: 光有日志没人看。落 ops_incidents → 次日 09:30 运营简报里红色置顶。
    await reportCronIncident({
      kind: "zero_output", severity: "error", tenantId: SYS,
      message: `每日生成零产出(目标 ${targetTotal} 篇, 失败 ${failures.length} 项, 选不出题 ${skipped.noTopic} 次 / 选不出刊 ${skipped.noJournal} 次)`,
      detail: runFacts,
    });
  } else if (targetTotal > 0 && totalProduced < targetTotal * LOW_OUTPUT_RATIO) {
    // 7-28 ①b: 零产出与"目标 20 出了 1 篇"是两种病, 后者原来完全静默。
    //   刻意是黄色不是红色: 系统还活着、还在出货, 只是明显不够 —— 要人看一眼配额/期刊池, 不用半夜爬起来。
    logger.warn({ ...runFacts }, `⚠️ 每日生成产出不足: ${totalProduced}/${targetTotal} 篇`);
    await reportCronIncident({
      kind: "low_output", severity: "warn", tenantId: SYS,
      message: `每日生成只出 ${totalProduced}/${targetTotal} 篇(不足目标 ${Math.round(LOW_OUTPUT_RATIO * 100)}%): 选不出题 ${skipped.noTopic} 次 · 选不出刊 ${skipped.noJournal} 次 · 生成失败 ${failures.length} 次`,
      detail: runFacts,
    });
  }
  logger.info({ roundupCount, articles: batchIds.length, failures: failures.length, totalProduced, targetTotal }, "PR-O3 每日内容(按类型)生成完成");
  return {
    selectedKeywords: batchIds.length, articlesEnqueued: totalProduced,
    failures, batchIds, startedAt, finishedAt: new Date().toISOString(),
    fallbackLevel: 0, diversityStats: { uniqueJournals: uniqueJournals.size, disciplines: [...usedDisc] },
  };
}
