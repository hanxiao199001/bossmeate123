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

type Scope = "domestic" | "international" | null;

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
  const journalCache = new Map<string, { discipline: string | null; scope: Scope }>();

  for (const art of arts) {
    const { discipline: disc, scope } = await resolveArticle(art.metadata as Record<string, unknown> | null, journalCache);
    // 6-19: 账号"国内/国外"定位过滤 — 账号定 domestic/international 且与文章期刊范围明确冲突时排除;
    //       账号 both 或文章范围未知 → 不限制(绝不因信息缺失误杀内容)。
    const scopeOk = (a: AccountLite) => a.journalScope === "both" || !scope || a.journalScope === scope;
    const pool = accounts.filter(scopeOk);
    // 领域匹配的号优先; 领域不限的号兜底
    const matching = pool.filter((a) => disc && a.disciplines.includes(disc));
    const open = pool.filter((a) => a.disciplines.length === 0);
    const candidatesAll = matching.length > 0 ? matching : open;
    // PR-B1: 剔除已达每日上限的号 (今日已发+本轮已分 >= DAILY_CAP)
    const candidates = candidatesAll.filter((a) => (load.get(a.id) ?? 0) < DAILY_CAP);
    if (candidatesAll.length === 0) {
      const why = pool.length === 0 && scope
        ? `没有定位为"${scope === "domestic" ? "国内核心" : "国外期刊"}"或不限范围的公众号`
        : `没有领域含"${disc}"或不限领域的公众号`;
      unmatched.push({ articleId: art.id, discipline: disc, reason: why });
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
