/**
 * PR-W6: 智能配对 — 推荐池文章 → 公众号, 按"文章学科 ↔ 账号领域"配对, 取代笛卡尔积同文多发。
 * 规则:
 *   1. 文章学科: metadata.discipline 优先, 没有则查关联期刊的 discipline, 都没有=不限。
 *   2. 候选账号: 领域含该学科的号 + 领域不限的号 (前者优先)。
 *   3. 每篇只配一个号 (独家), 同轮负载均衡 — 谁分到的少给谁。
 *   4. 配不上的文章返回 unmatched, 由调用方决定跳过或提示。
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, contentPublishLog, journals, platformAccounts, tenants } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export interface SmartPair {
  articleId: string;
  accountId: string;
  discipline: string | null;
}

export interface SmartAssignResult {
  pairs: SmartPair[];
  unmatched: Array<{ articleId: string; discipline: string | null; reason: string }>;
  /** 7-14: 两轮保底后仍未达下限的号 (内容不足信号, 供调用方报告) */
  shortfalls?: Array<{ accountId: string; assigned: number; target: number }>;
}

interface AccountLite {
  id: string;
  disciplines: string[];
  journalScope: string; // domestic | international | both — 账号"国内核心/国外期刊"定位
}

// 6-17 #2: 期刊名→学科 兜底推导(镜像 scripts/backfill-discipline.ts 的 inferDisciplineFromName)。
// journals.discipline 列对国内刊大面积为空, 直接查列会拿不到 → 配对退化成"领域不限/空置"。
// 这里在列为空时按期刊名现场推导, 不依赖空列、也不写库, 让独家/领域配对真正生效。
function inferDisciplineFromName(name: string): string | null {
  const lower = (name || "").toLowerCase();
  if (!lower.trim()) return null;
  if (/\b(lancet|jama|bmj|nejm|medicine|medical|clinical|cancer|cardio|surg|nurs|pharm|immun|infect|epidem|oncol|pathol|radiol|anesthes|dermat|gastro|hepat|nephro|neurol|ophthal|otolar|pediatr|psychiat|urol)\b/.test(lower)) return "medicine";
  if (/\b(psychol|cognit|behav|mental)\b/.test(lower)) return "psychology";
  if (/\b(educ|teach|learn|pedagog|curricul)\b/.test(lower)) return "education";
  if (/\b(econom|financ|business|manag|account|market)\b/.test(lower)) return "economics";
  if (/\b(engineer|material|energy|electr|mechan|autom)\b/.test(lower)) return "engineering";
  if (/\b(comput|inform|software|artificial|intellig|data sci|cyber|robot)\b/.test(lower)) return "computer";
  if (/\b(biolog|biochem|genetic|molecul|cell|microb|ecolog|zoolog|botan)\b/.test(lower)) return "biology";
  if (/\b(chem|catalys|polym)\b/.test(lower)) return "chemistry";
  if (/\b(physic|astron|quantum|optic)\b/.test(lower)) return "physics";
  if (/\b(agric|plant|crop|soil|food|horti|veterina|animal|aqua|forest)\b/.test(lower)) return "agriculture";
  if (/\b(environ|earth|climat|geolog|ocean|atmosph|sustain)\b/.test(lower)) return "environment";
  if (/\b(law|legal|juris|crimin)\b/.test(lower)) return "law";
  if (/\b(social|sociol|polit|commun|anthropo|geograph)\b/.test(lower)) return "economics";
  // 名字推不出明确学科时返回 null(而非硬塞 multidisciplinary), 让其落"领域不限"兜底号
  return null;
}

export type Scope = "domestic" | "international" | null;

// 6-19: 把期刊判成 国内核心/国外期刊 (镜像 journal-scope.ts 的 journalScopeCondition, JS 版)。
//   国内核心 = 有中文目录标签(catalogs 非空); 国外期刊 = 无中文标签且有 IF 或分区; 其余=未知(不限制)。
function classifyScope(j: { catalogs: unknown; impactFactor: number | null; partition: string | null; name?: string | null }): Scope {
  const cats = Array.isArray(j.catalogs) ? (j.catalogs as unknown[]) : [];
  if (cats.length > 0) return "domestic";
  if (j.impactFactor != null || (typeof j.partition === "string" && j.partition.length > 0)) return "international";
  // 6-19: 三无数据(无目录/无IF/无分区)的刊按刊名语言兜底 — 刊名含中文=国内中文刊(如《高校应用数学学报》),
  //   不再被判"未知"而绕过国内/国外定位过滤。纯英文名无指标仍判未知(不强判国外, 可能是不明来源刊)。
  if (/[\u4e00-\u9fff]/.test(String(j.name ?? ""))) return "domestic";
  return null;
}

// 6-19: 一次取出文章的 学科 + 国内/国外范围。同刊缓存, 避免循环里重复查库。
async function resolveArticle(
  meta: Record<string, unknown> | null,
  cache: Map<string, { discipline: string | null; scope: Scope }>,
): Promise<{ discipline: string | null; scope: Scope }> {
  if (!meta) return { discipline: null, scope: null };
  const metaDisc = typeof meta.discipline === "string" && meta.discipline ? meta.discipline : null;
  const jid = typeof meta.journalId === "string" ? meta.journalId : null;
  if (!jid) return { discipline: metaDisc, scope: null };
  if (cache.has(jid)) {
    const c = cache.get(jid)!;
    return { discipline: metaDisc ?? c.discipline, scope: c.scope };
  }
  let jDisc: string | null = null;
  let scope: Scope = null;
  try {
    const [j] = await db.select({
      discipline: journals.discipline, name: journals.name, nameEn: journals.nameEn,
      catalogs: journals.catalogs, impactFactor: journals.impactFactor, partition: journals.partition,
    }).from(journals).where(eq(journals.id, jid)).limit(1);
    if (j) {
      jDisc = j.discipline || inferDisciplineFromName(j.nameEn || j.name || "");
      scope = classifyScope(j as any);
    }
  } catch { /* noop */ }
  cache.set(jid, { discipline: jDisc, scope });
  return { discipline: metaDisc ?? jDisc, scope };
}

/**
 * 7-14 单一流水线·学科相邻表 (第2轮兜底只在相邻集内取, 八竿子打不着的宁缺不硬塞)。
 *   对称、保守: 医↔生↔化(近药)、生↔农↔环、经↔法(社科)、教↔心 等; 法学文绝不塞给医学号。
 *   退役 A 路后, 这张表是"相邻兜底"的唯一权威源(原 daily-cron ADJACENT_DISCIPLINES 已随 A 路删除)。
 */
export const DISCIPLINE_ADJACENCY: Record<string, string[]> = {
  medicine:    ["biology", "psychology", "chemistry"], // 医↔生↔心; chem 近药学
  biology:     ["medicine", "chemistry", "agriculture", "environment"],
  chemistry:   ["biology", "physics", "environment", "medicine"],
  physics:     ["engineering", "chemistry", "computer"],
  engineering: ["computer", "physics", "environment"],
  computer:    ["engineering", "physics"],
  psychology:  ["medicine", "education"],
  education:   ["psychology"],
  economics:   ["law"],                                // 经↔法/社科
  law:         ["economics"],
  environment: ["biology", "agriculture", "chemistry", "engineering"],
  agriculture: ["biology", "environment"],
};

/**
 * 第2轮兜底可否把某学科文章补给某号:
 *   - 领域不限号(disciplines 空): 接受任意学科(仍受 scope 硬约束) —— 它本就没有领域偏好。
 *   - 领域号: 文章学科须 ∈ 该号偏好学科的"自身 ∪ 相邻集", 否则宁缺(记 shortfall, 不硬塞无关领域)。
 *   - 无学科(discipline=null)文章: 不硬塞给领域号(核不出相邻关系), 只可落领域不限号。
 */
export function isAdjacentForAccount(acctDisciplines: string[], artDiscipline: string | null): boolean {
  if (acctDisciplines.length === 0) return true;
  if (!artDiscipline) return false;
  for (const d of acctDisciplines) {
    if (d === artDiscipline) return true;
    if ((DISCIPLINE_ADJACENCY[d] ?? []).includes(artDiscipline)) return true;
  }
  return false;
}

// ============ 7-14 两轮保底分配 (纯函数, 无 DB, 可单测) ============
export interface ResolvedArticle {
  id: string;
  discipline: string | null;
  scope: Scope;
  /** metadata.exclusiveAccountId — 账号驱动保底定向生成时绑定的号 */
  exclusiveAccountId?: string | null;
}
export interface AssignAccountLite {
  id: string;
  disciplines: string[];
  journalScope: string; // domestic | international | both
}
export interface TwoRoundResult {
  pairs: SmartPair[];
  unmatched: SmartAssignResult["unmatched"];
  /** 两轮后仍未达保底下限的号 (内容不足的信号, 供调用方明确报告, 不静默) */
  shortfalls: Array<{ accountId: string; assigned: number; target: number }>;
}

/**
 * 两轮保底分配。核心诉求: 每个公众号每天尽量到 target(保底下限) 篇, 不超 cap(上限)。
 *  第0轮 独家绑定: exclusiveAccountId 的文章直派该号 (≤cap)。
 *  第1轮 领域优先: 每篇配"领域含该学科(或不限领域)且范围相容"的号, 负载均衡, 每号先填到 target。
 *  第2轮 相邻兜底: 仍 < target 的号, 从剩余未分配文章补, 但只在【相邻学科集】内取(范围仍严格);
 *                八竿子打不着的宁缺(法学文绝不塞医学号), 补不到落 shortfalls 告警; 逐轮各号 +1 = 雨露均沾。
 * 红线一篇一号: assigned 集合全程去重 — 同一 articleId 绝不出现在两个号。
 */
export function assignArticlesTwoRound(opts: {
  articles: ResolvedArticle[]; // 应已按质检分降序 (名额有限时高分先占坑)
  accounts: AssignAccountLite[];
  preload?: Map<string, number>; // 今日各号已发数 (load 起点, 让 上限/下限 对"今日已发+本轮"一起生效)
  target: number; // 保底下限
  cap: number;    // 每号上限
}): TwoRoundResult {
  const cap = Math.max(1, Math.floor(opts.cap));
  const target = Math.max(0, Math.min(Math.floor(opts.target), cap)); // 夹在 [0, cap]
  const accounts = opts.accounts;
  const acctIds = new Set(accounts.map((a) => a.id));
  const load = new Map<string, number>(accounts.map((a) => [a.id, opts.preload?.get(a.id) ?? 0]));
  const pairs: SmartPair[] = [];
  const unmatched: TwoRoundResult["unmatched"] = [];
  const assigned = new Set<string>();
  const scopeOk = (a: AssignAccountLite, scope: Scope) => a.journalScope === "both" || !scope || a.journalScope === scope;

  // ---- 第0轮: 独家绑定直派 (≤cap) ----
  const boundIds = new Set<string>();
  for (const art of opts.articles) {
    const ex = art.exclusiveAccountId;
    if (!ex || !acctIds.has(ex)) continue;
    boundIds.add(art.id); // 已定向 → 不让别号在后续轮次抢走
    if ((load.get(ex) ?? 0) < cap) {
      pairs.push({ articleId: art.id, accountId: ex, discipline: art.discipline });
      load.set(ex, (load.get(ex) ?? 0) + 1);
      assigned.add(art.id);
    } else {
      unmatched.push({ articleId: art.id, discipline: art.discipline, reason: `已绑定的号今日已达发布上限(${cap}篇/天)` });
    }
  }
  const rest = opts.articles.filter((a) => !boundIds.has(a.id));

  // ---- 第1轮: 领域优先, 负载均衡填到 target ----
  for (const art of rest) {
    const pool = accounts.filter((a) => scopeOk(a, art.scope));
    if (pool.length === 0) {
      unmatched.push({
        articleId: art.id, discipline: art.discipline,
        reason: art.scope ? `没有定位为"${art.scope === "domestic" ? "国内核心" : "国外期刊"}"或不限范围的公众号` : "无可用公众号",
      });
      continue;
    }
    const matching = pool.filter((a) => art.discipline && a.disciplines.includes(art.discipline));
    const open = pool.filter((a) => a.disciplines.length === 0);
    const candAll = matching.length > 0 ? matching : open;
    const cand = candAll.filter((a) => (load.get(a.id) ?? 0) < target);
    if (cand.length === 0) continue; // 对口号都已到下限 → 留作第2轮兜底料 (不误报 unmatched)
    cand.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
    const picked = cand[0]!;
    load.set(picked.id, (load.get(picked.id) ?? 0) + 1);
    pairs.push({ articleId: art.id, accountId: picked.id, discipline: art.discipline });
    assigned.add(art.id);
  }

  // ---- 第2轮: 相邻学科兜底 (只在相邻集内补, 范围仍严格; 逐轮各号 +1 雨露均沾) ----
  //   八竿子打不着的宁缺(法学文绝不塞医学号): 候选文章学科须在该号"自身 ∪ 相邻集"内(领域不限号除外)。
  //   补不到 → 该号留在当前篇数, 落 shortfalls 告警, 不硬塞无关领域。
  let progressed = true;
  while (progressed) {
    progressed = false;
    const below = accounts
      .filter((a) => (load.get(a.id) ?? 0) < target)
      .sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
    for (const acc of below) {
      const art = rest.find(
        (a) => !assigned.has(a.id) && scopeOk(acc, a.scope) && isAdjacentForAccount(acc.disciplines, a.discipline),
      );
      if (!art) continue;
      pairs.push({ articleId: art.id, accountId: acc.id, discipline: art.discipline });
      load.set(acc.id, (load.get(acc.id) ?? 0) + 1);
      assigned.add(art.id);
      progressed = true;
    }
  }

  const shortfalls = accounts
    .filter((a) => (load.get(a.id) ?? 0) < target)
    .map((a) => ({ accountId: a.id, assigned: load.get(a.id) ?? 0, target }));

  return { pairs, unmatched, shortfalls };
}

/**
 * 计算配对。accountIds 为空 = 用租户全部启用的公众号。
 */
export async function computeSmartPairs(opts: {
  tenantId: string;
  articleIds: string[];
  accountIds?: string[];
  /** 7-05 ⑤: 覆盖每号每日上限 (cap, 草稿箱分发 top-N 用; 缺省走 publishLimits 配置/默认1) */
  dailyCap?: number;
  /** 7-14: 每号每日保底下限 (target, 两轮保底填到该数; 缺省=cap, 即老行为"填到上限") */
  target?: number;
}): Promise<SmartAssignResult> {
  const { tenantId, articleIds } = opts;
  if (articleIds.length === 0) return { pairs: [], unmatched: [] };

  const accountRows = await db
    .select({
      id: platformAccounts.id,
      platform: platformAccounts.platform,
      status: platformAccounts.status,
      discipline: platformAccounts.discipline,
      disciplines: platformAccounts.disciplines,
      journalScope: platformAccounts.journalScope,
    })
    .from(platformAccounts)
    .where(eq(platformAccounts.tenantId, tenantId));

  const accounts: AccountLite[] = accountRows
    .filter((a) => a.platform === "wechat" && a.status === "active")
    .filter((a) => !opts.accountIds || opts.accountIds.length === 0 || opts.accountIds.includes(a.id))
    .map((a) => ({
      id: a.id,
      disciplines: Array.isArray(a.disciplines) && (a.disciplines as string[]).length > 0
        ? (a.disciplines as string[])
        : a.discipline ? [a.discipline] : [],
      journalScope: (a.journalScope as string) || "both",
    }));

  if (accounts.length === 0) {
    return { pairs: [], unmatched: articleIds.map((id) => ({ articleId: id, discipline: null, reason: "无可用公众号" })) };
  }

  const artsRaw = await db
    .select({ id: contents.id, metadata: contents.metadata })
    .from(contents)
    .where(inArray(contents.id, articleIds));
  // PR-B1 精品优先: 名额有限时, 质检分高的先占坑
  const arts = [...artsRaw].sort((a, b) => {
    const sa = Number((a.metadata as any)?.qualityScore ?? (a.metadata as any)?.aiScore ?? 0);
    const sb = Number((b.metadata as any)?.qualityScore ?? (b.metadata as any)?.aiScore ?? 0);
    return sb - sa;
  });

  // PR-B1/7-14: 每号每日 上限(cap) 与 保底下限(target)。cap 缺省走 publishLimits 配置/默认1; target 缺省=cap。
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const cfgLimit = Number((t?.config as any)?.publishLimits?.perAccountPerDay);
  const CAP = Number.isFinite(opts.dailyCap) && (opts.dailyCap as number) > 0
    ? Math.floor(opts.dailyCap as number)
    : Number.isFinite(cfgLimit) && cfgLimit > 0 ? Math.floor(cfgLimit) : 1; // 公众号默认 1/天
  const TARGET = Number.isFinite(opts.target) && (opts.target as number) >= 0
    ? Math.min(CAP, Math.floor(opts.target as number))
    : CAP; // 缺省=cap → 老行为(填到上限)

  // 今日各号已发数 (北京时间当日) — 作为 load 起点, 让 上限/下限 对"今日已发+本轮分配"一起生效
  const bj = new Date(Date.now() + 8 * 3600_000); bj.setUTCHours(0, 0, 0, 0);
  const since = new Date(bj.getTime() - 8 * 3600_000);
  const pubRows = await db
    .select({ accountId: contentPublishLog.accountId, n: sql<string>`COUNT(*)` })
    .from(contentPublishLog)
    .where(and(eq(contentPublishLog.tenantId, tenantId), gte(contentPublishLog.createdAt, since)))
    .groupBy(contentPublishLog.accountId);
  const preload = new Map<string, number>(pubRows.map((r) => [r.accountId, Number(r.n)]));

  // 逐篇解析 学科 + 国内/国外范围 + 独家绑定 (async, 同刊缓存); 再交给纯函数做两轮保底分配。
  const journalCache = new Map<string, { discipline: string | null; scope: Scope }>();
  const resolved: ResolvedArticle[] = [];
  for (const art of arts) {
    const meta = art.metadata as Record<string, any> | null;
    const { discipline, scope } = await resolveArticle(meta as Record<string, unknown> | null, journalCache);
    const ex = typeof meta?.exclusiveAccountId === "string" ? (meta.exclusiveAccountId as string) : null;
    resolved.push({ id: art.id, discipline, scope, exclusiveAccountId: ex });
  }

  const { pairs, unmatched, shortfalls } = assignArticlesTwoRound({
    articles: resolved, accounts, preload, target: TARGET, cap: CAP,
  });

  if (shortfalls.length > 0) {
    logger.warn(
      { tenantId, target: TARGET, cap: CAP, shortfalls, articles: arts.length, accounts: accounts.length },
      `⚠️ 7-14 保底未达标: ${shortfalls.length} 个号 < ${TARGET} 篇/天 — 内容不足, 需提高生成量或补内容`,
    );
  }
  logger.info(
    { tenantId, articles: arts.length, paired: pairs.length, unmatched: unmatched.length, target: TARGET, cap: CAP },
    "PR-W6/7-14 smart-assign 两轮保底配对完成",
  );
  return { pairs, unmatched, shortfalls };
}
