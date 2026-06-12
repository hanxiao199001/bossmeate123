/**
 * PR-W6: 智能配对 — 推荐池文章 → 公众号, 按"文章学科 ↔ 账号领域"配对, 取代笛卡尔积同文多发。
 * 规则:
 *   1. 文章学科: metadata.discipline 优先, 没有则查关联期刊的 discipline, 都没有=不限。
 *   2. 候选账号: 领域含该学科的号 + 领域不限的号 (前者优先)。
 *   3. 每篇只配一个号 (独家), 同轮负载均衡 — 谁分到的少给谁。
 *   4. 配不上的文章返回 unmatched, 由调用方决定跳过或提示。
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, journals, platformAccounts } from "../../models/schema.js";
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

  const arts = await db
    .select({ id: contents.id, metadata: contents.metadata })
    .from(contents)
    .where(inArray(contents.id, articleIds));

  const load = new Map<string, number>(accounts.map((a) => [a.id, 0]));
  const pairs: SmartPair[] = [];
  const unmatched: SmartAssignResult["unmatched"] = [];

  for (const art of arts) {
    const disc = await articleDiscipline(art.metadata as Record<string, unknown> | null);
    // 领域匹配的号优先; 领域不限的号兜底
    const matching = accounts.filter((a) => disc && a.disciplines.includes(disc));
    const open = accounts.filter((a) => a.disciplines.length === 0);
    const candidates = matching.length > 0 ? matching : open;
    if (candidates.length === 0) {
      unmatched.push({ articleId: art.id, discipline: disc, reason: `没有领域含"${disc}"或不限领域的公众号` });
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
