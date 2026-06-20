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
import { recommendJournals } from "./journal-recommender.js";
import { createBatch } from "../batch/batch-service.js";
import { generateRoundupArticle } from "../content-engine/roundup-generator.js";
import { journalScopeCondition } from "./journal-scope.js";
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

// ============ PR-O3: 每日内容生成(按类型) ============
const ALL_DISC_CODES = ["medicine", "education", "economics", "engineering", "computer", "agriculture", "environment", "law", "psychology", "biology", "chemistry", "physics"];
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
export async function getContentQuota(): Promise<Record<string, { count: number; disciplines: string[] }> | null> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
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

/** 选一本 定位+学科 的刊。逐级兜底保证篇数=配置:
 *  ① 范围+学科+15天新刊(最佳) → ② 去冷却(同范围同学科里取最久未用) → ③ 去学科(保范围+新刊)
 *  → ④ 仅范围(最久未用) → ⑤ 去范围(仅新刊) → ⑥ 全放开(最久未用)。
 *  根因: 国内刊 discipline 大面积为空 + 小学科15天冷却耗尽, 严选会大量空名额; 兜底让每个名额都出刊。 */
async function pickScopedFreshJournal(tenantId: string, scope: string, discipline: string): Promise<string | null> {
  // 6-19 数据质量护栏: 排除 ai_fabricated(生成时 LLM 编造、IF/分区/录用率是假的)刊, 不让它们进每日生成。
  //   只排这一类: 正经的低可信/目录刊(国内核心常 confidence 为空)仍保留, 不误杀。
  const active = and(eq(journals.status, "active"), sql`(${journals.dataSource} IS DISTINCT FROM 'ai_fabricated')`);
  const sc = journalScopeCondition(scope); // SQL | null
  const disc = sql`${journals.discipline} ILIKE ${"%" + discipline + "%"}`;
  const fresh = sql`NOT EXISTS (SELECT 1 FROM journal_usage ju WHERE ju.journal_id = ${journals.id} AND ju.tenant_id = ${tenantId} AND ju.used_at > NOW() - make_interval(days => ${JOURNAL_COOLDOWN_DAYS}))`;
  // 去冷却的层级按"最久未用"优先, 保证轮换(而非反复用同几本)
  const lru = sql`(SELECT max(ju.used_at) FROM journal_usage ju WHERE ju.journal_id = ${journals.id} AND ju.tenant_id = ${tenantId}) ASC NULLS FIRST`;
  const rnd = sql`random()`;
  const pick = async (conds: Array<unknown>, order: unknown): Promise<string | null> => {
    const cs = conds.filter(Boolean) as Parameters<typeof and>;
    const [j] = await db.select({ id: journals.id }).from(journals).where(and(...cs)).orderBy(order as any).limit(1);
    return j?.id ?? null;
  };
  // 6-19 修"国外槽位漏国内刊": 兜底绝不丢 scope —— 只放宽 学科/冷却, 国内/国外定位始终保留。
  //   国外刊池用尽时返回 null(该槽位跳过/空着), 也不退回国内刊(否则国内刊被当国外内容生成又错发到国外号)。
  return (await pick([active, sc, disc, fresh], rnd))
    ?? (await pick([active, sc, disc], lru))
    ?? (await pick([active, sc, fresh], rnd))
    ?? (await pick([active, sc], lru));
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

  for (const [type, cfg] of Object.entries(cq)) {
    if (!cfg.count) continue;
    const discs = cfg.disciplines.length ? cfg.disciplines : ALL_DISC_CODES;
    for (let i = 0; i < cfg.count; i++) {
      const discipline = discs[i % discs.length];
      usedDisc.add(discipline);
      try {
        if (type === "roundup") {
          const { title, html, journalCovers, journalIds } = await generateRoundupArticle({ tenantId: SYS, discipline, count: 3, audience: "普通院校教师" });
          const [row] = await db.insert(contents).values({
            tenantId: SYS, userId: SYS_USER, type: "article", title, body: html,
            // 多刊盘点是成品文章, 直接 generated 进批量发布(原误存 draft 导致进不了内容工坊批量导入)
            ...initialStatusFields("generated"),
            metadata: { source: "roundup", templateId: "journal-roundup", discipline, journalCovers },
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
          if (!pick) { logger.info({ tenantId: SYS }, "PR-V1 选题池无可用新题, 跳过"); continue; }
          const { generateByFormat } = await import("../content-engine/format-generators.js");
          const gen = await generateByFormat({
            tenantId: SYS, userId: SYS_USER, topic: pick.keyword, format: "article",
          });
          // PR-U2 轻量质检: 字数下限 + 合规硬词; 过 → generated, 不过 → needs_review
          const { checkCompliance } = await import("../compliance/content-check.js");
          const comp = await checkCompliance(`${gen.title}\n${gen.body}`);
          const plainLen = (gen.body || "").replace(/<[^>]+>/g, "").length;
          const qcPass = plainLen >= 300 && !comp.blocked;
          const [row] = await db.insert(contents).values({
            tenantId: SYS, userId: SYS_USER, type: "article",
            title: gen.title, body: gen.body,
            ...initialStatusFields(qcPass ? "generated" : "needs_review"),
            metadata: { source: "topic_pool", topic: pick.keyword, needsReview: !qcPass, ...gen.metadata },
          }).returning({ id: contents.id });
          if (row?.id) batchIds.push(row.id);
          await db.update(keywordsTable).set({ lastRecommendedAt: new Date() }).where(eq(keywordsTable.id, pick.id));
        } else if (type === "domestic" || type === "international") {
          const journalId = await pickScopedFreshJournal(SYS, type, discipline);
          if (!journalId) { logger.info({ type, discipline }, "PR-O3 该范围无可用新刊, 跳过"); continue; }
          const cands = await selectCandidates({ disciplines: [discipline], cooldownDays: 0, poolSize: 5 });
          const topic = cands[0]?.keyword ?? discipline;
          const result = await createBatch({
            tenantId: SYS, userId: SYS_USER,
            filename: `daily-${type}-${discipline}-${new Date().toISOString().slice(0, 10)}`,
            rows: [{ rowIndex: 1, topic, journalId, templateId: pickTemplateId(tplWeights), template: "A", priority: 3 }],
          });
          batchIds.push(result.batchId);
          uniqueJournals.add(journalId);
          await db.insert(journalUsage).values({ tenantId: SYS, journalId });
          if (cands[0]) await db.update(keywordsTable).set({ lastRecommendedAt: new Date() }).where(eq(keywordsTable.id, cands[0].id));
        }
      } catch (err) {
        const error = (err as Error).message || String(err);
        failures.push({ keyword: `${type}/${discipline}`, error });
        logger.warn({ type, discipline, err }, "PR-O3 单项生成失败(跳过)");
      }
    }
  }
  const totalProduced = batchIds.length + roundupCount;
  if (totalProduced === 0) {
    // 零产出告警: 别再静默停摆几天没人发现。失败明细一并打出, 便于定位(余额/冷却/候选枯竭)。
    logger.error({ tenant: SYS, failures, types: Object.keys(cq) }, "⚠️ 每日生成零产出! 请检查 LLM 余额 / 期刊冷却 / 候选词。详见 failures");
  }
  logger.info({ roundupCount, articles: batchIds.length, failures: failures.length, totalProduced }, "PR-O3 每日内容(按类型)生成完成");
  return {
    selectedKeywords: batchIds.length, articlesEnqueued: totalProduced,
    failures, batchIds, startedAt, finishedAt: new Date().toISOString(),
    fallbackLevel: 0, diversityStats: { uniqueJournals: uniqueJournals.size, disciplines: [...usedDisc] },
  };
}
