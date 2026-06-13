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
}

interface AccountLite {
  id: string;
  disciplines: string[];
}

async function articleDiscipline(meta: Record<string, unknown> | null): Promise<string | null> {
  if (!meta) return null;
  if (typeof meta.discipline === "string" && meta.discipline) return meta.discipline;
  const jid = typeof meta.journalId === "string" ? meta.journalId : null;
  if (jid) {
    try {
      const [j] = await db.select({ discipline: journals.discipline }).from(journals).where(eq(journals.id, jid)).limit(1);
      return j?.discipline ?? null;
    } catch { /* noop */ }
  }
  return null;
}

/**
 * 计算配对。accountIds 为空 = 用租户全部启用的公众号。
 */
export async function computeSmartPairs(opts: {
  tenantId: string;
  articleIds: string[];
  accountIds?: string[];
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

  // PR-B1 宁缺毋滥: 每号每日发布上限 (公众号订阅号本就日发1次; 配置可覆盖)
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const cfgLimit = Number((t?.config as any)?.publishLimits?.perAccountPerDay);
  const DAILY_CAP = Number.isFinite(cfgLimit) && cfgLimit > 0 ? Math.floor(cfgLimit) : 1; // 公众号默认 1/天
  // 今日各号已发数 (北京时间当日)
  const bj = new Date(Date.now() + 8 * 3600_000); bj.setUTCHours(0, 0, 0, 0);
  const since = new Date(bj.getTime() - 8 * 3600_000);
  const pubRows = await db
    .select({ accountId: contentPublishLog.accountId, n: sql<string>`COUNT(*)` })
    .from(contentPublishLog)
    .where(and(eq(contentPublishLog.tenantId, tenantId), gte(contentPublishLog.createdAt, since)))
    .groupBy(contentPublishLog.accountId);
  const publishedToday = new Map<string, number>(pubRows.map((r) => [r.accountId, Number(r.n)]));

  // load 起点 = 今日已发数, 这样上限对"今日已发+本轮分配"一起生效
  const load = new Map<string, number>(accounts.map((a) => [a.id, publishedToday.get(a.id) ?? 0]));
  const pairs: SmartPair[] = [];
  const unmatched: SmartAssignResult["unmatched"] = [];

  for (const art of arts) {
    const disc = await articleDiscipline(art.metadata as Record<string, unknown> | null);
    // 领域匹配的号优先; 领域不限的号兜底
    const matching = accounts.filter((a) => disc && a.disciplines.includes(disc));
    const open = accounts.filter((a) => a.disciplines.length === 0);
    const candidatesAll = matching.length > 0 ? matching : open;
    // PR-B1: 剔除已达每日上限的号 (今日已发+本轮已分 >= DAILY_CAP)
    const candidates = candidatesAll.filter((a) => (load.get(a.id) ?? 0) < DAILY_CAP);
    if (candidatesAll.length === 0) {
      unmatched.push({ articleId: art.id, discipline: disc, reason: `没有领域含"${disc}"或不限领域的公众号` });
      continue;
    }
    if (candidates.length === 0) {
      unmatched.push({ articleId: art.id, discipline: disc, reason: `匹配的号今日已达发布上限(${DAILY_CAP}篇/天),宁缺毋滥` });
      continue;
    }
    // 负载均衡: 本轮分到最少的优先
    candidates.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
    const picked = candidates[0]!;
    load.set(picked.id, (load.get(picked.id) ?? 0) + 1);
    pairs.push({ articleId: art.id, accountId: picked.id, discipline: disc });
  }

  logger.info({ tenantId, articles: arts.length, paired: pairs.length, unmatched: unmatched.length }, "PR-W6 smart-assign 配对完成");
  return { pairs, unmatched };
}
