/**
 * 期刊池资源盘点 (7-30) —— 架构修复设计框架「感知能力」的第一步。
 *
 * ## 病根: 选刊器的降级是**试探式**的
 *
 * `pickScopedFreshJournal` 十层兜底, 一层层往下 pick, 试到有为止 —— 系统直到试完才知道
 * "这个学科没刊了", 而且知道的方式是"我刚才降级了", 不是"我还剩几本"。实测后果:
 *
 *   · 国际教育刊全库只有 6 本, 而近 30 天教育学选题 240 次 → 6 本刊被反复用 22 次;
 *   · 日志只打"目标学科对口刊已枯竭, 回退综合刊"这条**看起来完全正常**的业务话;
 *   · 老板肉眼发现"国际刊反复就那几本"时, 这个状态已经持续了几周。
 *
 * **"哪个学科还剩几本可选"这个事实, 数据一直在库里, 但从来没有任何模块算过它。**
 * 这个文件就是算它的那个模块。
 *
 * ## 与选刊器的关系: 同一份 WHERE, 不是"照着写一遍"
 *
 * 余量的定义只有一个才有意义 —— 如果盘点说"教育学还有 20 本"而选刊器一本都选不出来,
 * 这张表比没有更糟(它让人相信了一个假数)。所以条件片段全部取自
 * `journal-sql.ts#journalPoolCriteria()`, 与 `pickScopedFreshJournal` 是**同一个函数的返回值**。
 * 回归锁: `__tests__/journal-pool-criteria-single-source.test.ts`。
 *
 * ## 这一轮只做"知道 + 报出来", 不改排产行为
 *
 * 排产前会调一次盘点、把"某学科今天注定要降级"写进 incident(见 daily-cron 的 preflight),
 * 但**不据此改变排产**。让降级在发生之前就被记录, 已经比事后归因前进了一整步;
 * 用余量去调配额/换学科是下一步"决策"的事, 混在一起做只会两件都做不干净。
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { journals, journalUsage } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { journalPoolCriteria, journalCooldownDays } from "./journal-sql.js";
import {
  DOMESTIC_KINDS,
  INTERNATIONAL_KINDS,
  type JournalKind,
} from "./journal-kind.js";
import {
  DISCIPLINE_CODES,
  GENERIC_DISCIPLINE_CODE,
} from "../recommendation/discipline-mapping.js";

// ============ 可配阈值 ============

/** 余量低于几本算告警(默认 5)。5 = 一个学科连着排产 5 天就见底, 属于"这周必须补货"。 */
export function poolLowWatermarkCount(): number {
  const n = Number(process.env.POOL_LOW_WATERMARK_COUNT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

/** 预计几天内枯竭算告警(默认 3)。3 天 = 补一批期刊数据来得及的最短提前量。 */
export function poolLowWatermarkDays(): number {
  const n = Number(process.env.POOL_LOW_WATERMARK_DAYS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

/**
 * 日均用量的统计窗口(默认 14 天)。
 * 取 14 而不是 30: 排产配额是运营随时在改的, 30 天窗口会把两周前已经调走的配额算进当前用量;
 * 取 14 又略长于 15 天冷却期的一半, 不至于被单日波动带偏。
 */
export function poolUsageWindowDays(): number {
  const n = Number(process.env.POOL_USAGE_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
}

// ============ 数据结构 ============

/** 盘点的最小粒度: discipline_code × journal_kind */
export interface PoolCell {
  disciplineCode: string;
  journalKind: string;
  /** 该组在架刊总数(active 且非 ai_fabricated) */
  total: number;
  /** 其中已核实的(分体系门槛) */
  verified: number;
  /** 其中已核实**且**冷却期内未被该租户用过 = 选刊器第①层真正能选到的 */
  freshVerified: number;
}

/** 运营看的粒度: 学科 × 定位(= 账号的 journalScope, 也是选刊器的 scope) */
export interface PoolInventoryRow {
  disciplineCode: string;
  /** "domestic" | "international" —— kind 'unknown' 不属于任何 scope, 见 unknownTotal */
  scope: "domestic" | "international";
  total: number;
  verified: number;
  /** 选刊器第①层(已核实 + 对口 + 新鲜)的真实池子大小 */
  freshVerified: number;
  /** 第②层的垫子: 同 scope 的综合刊(generic)里还有几本新鲜已核实的 */
  genericFreshVerified: number;
  /** 已核实但在冷却期内(= 未来 cooldownDays 天里会陆续放出来的) */
  inCooldown: number;
  /** 统计窗口内该 (学科×定位) 的用刊次数 */
  usesInWindow: number;
  /** 日均用量 = usesInWindow / windowDays */
  dailyUsage: number;
  /** 日均回补 = inCooldown / cooldownDays(冷却到期的刊会重新变新鲜) */
  replenishPerDay: number;
  /** 估算还能撑几天; null = 不预测(无用量 或 回补 ≥ 消耗即可持续) */
  exhaustedInDays: number | null;
  /**
   * 回补 ≥ 消耗 —— 池子**永续**转得过来。
   *
   * ⚠️ **不要拿它当「能不能投放」的判据**（8-19 踩过）。它区分的是
   * 「有没有人在用」而非「够不够用」：`dailyUsage = 0` 直接短路返回 true，
   * 而有消耗且净减的一律 false —— 哪怕还能撑 50000 天。实测：
   *
   * ```
   * medicine/international  可选 1143, 撑 20002 天  → sustainable = false
   * engineering/international 可选 631, 日耗 0      → sustainable = true
   * ```
   *
   * 要判「能不能投放」用 `isViableForAllocation()`。
   */
  sustainable: boolean;
  /** 低于水位线(freshVerified ≤ 阈值 或 预计 ≤ 阈值天枯竭), 且**确实有人在用** */
  low: boolean;
}

export interface PoolInventory {
  tenantId: string;
  cooldownDays: number;
  usageWindowDays: number;
  thresholds: { lowCount: number; lowDays: number };
  /** 按 freshVerified 升序(最该补货的排最前) */
  rows: PoolInventoryRow[];
  /** 只含 low=true 的行, 同样升序 */
  alerts: PoolInventoryRow[];
  /** 原始细胞(discipline_code × journal_kind), 排障/前端下钻用 */
  cells: PoolCell[];
  /** 对任何 scope 都不可见的刊(kind='unknown'): 有数据但选刊器永远选不到, 补数据的第一优先级 */
  invisibleUnknown: number;
  generatedAt: string;
}

const SCOPE_KINDS: Record<"domestic" | "international", readonly JournalKind[]> = {
  domestic: DOMESTIC_KINDS,
  international: INTERNATIONAL_KINDS,
};

const SCOPE_CN: Record<string, string> = { domestic: "国内核心", international: "国际刊" };

/** 学科码 → 中文(简报/报表给人看; 码本身是英文的) */
export const DISCIPLINE_CN: Record<string, string> = {
  medicine: "医学", education: "教育学", economics: "经济管理", engineering: "工程技术",
  computer: "计算机", agriculture: "农业", environment: "环境地理", law: "法律政治",
  psychology: "心理学", biology: "生物学", chemistry: "化学化工", physics: "物理",
  humanities: "人文社科", generic: "综合刊",
};
export const disciplineCn = (code: string): string => DISCIPLINE_CN[code] ?? code;

// ============ 采集 ============

/**
 * 盘点全学科余量。
 *
 * 两条查询:
 *   ① 池子: `journals` 按 (discipline_code, journal_kind) 分组, 用**选刊器的条件片段**做
 *      `count(*) FILTER (WHERE …)` —— total / verified / freshVerified 一次算齐。
 *   ② 用量: `journal_usage × journals` 近 N 天, 同样按 (discipline_code, journal_kind) 分组。
 *
 * ⚠️ 期刊表**不按租户过滤**(共享参考数据), 只有 fresh 与用量是按租户算的 —— 与选刊器一致。
 */
export async function getPoolInventory(opts: {
  tenantId: string;
  usageWindowDays?: number;
}): Promise<PoolInventory> {
  const tenantId = opts.tenantId;
  const usageWindowDays = Math.max(1, Math.floor(opts.usageWindowDays ?? poolUsageWindowDays()));
  const cooldownDays = journalCooldownDays();
  // discipline 传什么都行 —— 这里只用 active/verified/fresh 三个与学科无关的片段,
  // 学科维度靠 GROUP BY 出来(不是靠 WHERE 逐个学科查 13 次)。
  const c = journalPoolCriteria({ tenantId, discipline: GENERIC_DISCIPLINE_CODE, cooldownDays });

  const cellRows = await db
    .select({
      disciplineCode: journals.disciplineCode,
      journalKind: journals.journalKind,
      total: sql<number>`count(*)::int`,
      verified: sql<number>`count(*) FILTER (WHERE ${c.verified})::int`,
      freshVerified: sql<number>`count(*) FILTER (WHERE ${c.verified} AND ${c.fresh})::int`,
    })
    .from(journals)
    .where(c.active)
    .groupBy(journals.disciplineCode, journals.journalKind);

  // 用量数的是 **journal_usage 行数**(每行 = 一次排产占用), 不是"用过多少本不同的刊" ——
  // 后者在池子已枯竭时会把"6 本刊反复用 22 次"数成 6, 恰好在最该报警的场景下把需求算低。
  const usageRows = await db
    .select({
      disciplineCode: journals.disciplineCode,
      journalKind: journals.journalKind,
      uses: sql<number>`count(*)::int`,
    })
    .from(journalUsage)
    .innerJoin(journals, eq(journalUsage.journalId, journals.id))
    .where(and(
      eq(journalUsage.tenantId, tenantId),
      sql`${journalUsage.usedAt} > NOW() - make_interval(days => ${usageWindowDays})`,
    ))
    .groupBy(journals.disciplineCode, journals.journalKind);

  const cells: PoolCell[] = cellRows.map((r) => ({
    disciplineCode: String(r.disciplineCode ?? GENERIC_DISCIPLINE_CODE),
    journalKind: String(r.journalKind ?? "unknown"),
    total: Number(r.total ?? 0),
    verified: Number(r.verified ?? 0),
    freshVerified: Number(r.freshVerified ?? 0),
  }));
  const usage = new Map<string, number>();
  for (const r of usageRows) {
    usage.set(`${String(r.disciplineCode ?? GENERIC_DISCIPLINE_CODE)}|${String(r.journalKind ?? "unknown")}`, Number(r.uses ?? 0));
  }

  return buildInventory({ tenantId, cells, usage, cooldownDays, usageWindowDays });
}

/**
 * 纯函数: 细胞 → 学科×定位 余量表。抽出来是为了能脱库单测余量口径(见 pool-inventory.test.ts)。
 */
export function buildInventory(input: {
  tenantId: string;
  cells: PoolCell[];
  /** key = `${disciplineCode}|${journalKind}` */
  usage: Map<string, number>;
  cooldownDays: number;
  usageWindowDays: number;
}): PoolInventory {
  const { cells, usage, cooldownDays, usageWindowDays } = input;
  const lowCount = poolLowWatermarkCount();
  const lowDays = poolLowWatermarkDays();
  const cellOf = new Map(cells.map((x) => [`${x.disciplineCode}|${x.journalKind}`, x]));

  const sumOver = (disc: string, kinds: readonly JournalKind[], f: (c: PoolCell) => number): number =>
    kinds.reduce((n, k) => n + (cellOf.has(`${disc}|${k}`) ? f(cellOf.get(`${disc}|${k}`)!) : 0), 0);
  const usesOver = (disc: string, kinds: readonly JournalKind[]): number =>
    kinds.reduce((n, k) => n + (usage.get(`${disc}|${k}`) ?? 0), 0);

  const rows: PoolInventoryRow[] = [];
  for (const disciplineCode of DISCIPLINE_CODES) {
    for (const scope of ["domestic", "international"] as const) {
      const kinds = SCOPE_KINDS[scope];
      const total = sumOver(disciplineCode, kinds, (c) => c.total);
      const verified = sumOver(disciplineCode, kinds, (c) => c.verified);
      const freshVerified = sumOver(disciplineCode, kinds, (c) => c.freshVerified);
      const genericFreshVerified = sumOver(GENERIC_DISCIPLINE_CODE, kinds, (c) => c.freshVerified);
      const inCooldown = Math.max(0, verified - freshVerified);
      const usesInWindow = usesOver(disciplineCode, kinds);
      const dailyUsage = usesInWindow / usageWindowDays;
      const replenishPerDay = cooldownDays > 0 ? inCooldown / cooldownDays : 0;
      const { exhaustedInDays, sustainable } = estimateExhaustion({
        freshVerified, dailyUsage, replenishPerDay,
      });
      const low = dailyUsage > 0 && (
        freshVerified <= lowCount || (exhaustedInDays !== null && exhaustedInDays <= lowDays)
      );
      rows.push({
        disciplineCode, scope, total, verified, freshVerified, genericFreshVerified,
        inCooldown, usesInWindow,
        dailyUsage: round2(dailyUsage), replenishPerDay: round2(replenishPerDay),
        exhaustedInDays, sustainable, low,
      });
    }
  }

  // 最该补货的排最前: 余量少的优先; 同余量看谁撑得更短
  const bySeverity = (a: PoolInventoryRow, b: PoolInventoryRow): number =>
    a.freshVerified - b.freshVerified
    || (a.exhaustedInDays ?? 9999) - (b.exhaustedInDays ?? 9999)
    || b.dailyUsage - a.dailyUsage;
  rows.sort(bySeverity);

  return {
    tenantId: input.tenantId,
    cooldownDays,
    usageWindowDays,
    thresholds: { lowCount, lowDays },
    rows,
    alerts: rows.filter((r) => r.low),
    cells,
    invisibleUnknown: cells.filter((c) => c.journalKind === "unknown").reduce((n, c) => n + c.total, 0),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 估算还能撑几天。
 *
 * 池子**不是水箱是转盘**: 用掉的刊在冷却 cooldownDays 天后会重新变新鲜。所以纯用
 * `freshVerified / dailyUsage` 会系统性低估(把回补当成 0)。这里算净流失:
 *
 *   净流失/天 = 日均用量 − 日均回补,  日均回补 ≈ 冷却期内的刊数 / 冷却天数
 *
 * - 净流失 ≤ 0 → 转得过来, 不预测枯竭(sustainable)
 * - freshVerified = 0 且有用量 → 已经在降级了, 0 天
 *
 * 误差来源见 `PoolInventoryRow.exhaustedInDays` 的调用方注释与本文件报告。
 */
export function estimateExhaustion(x: {
  freshVerified: number;
  dailyUsage: number;
  replenishPerDay: number;
}): { exhaustedInDays: number | null; sustainable: boolean } {
  const net = x.dailyUsage - x.replenishPerDay;
  if (x.dailyUsage <= 0) return { exhaustedInDays: null, sustainable: true }; // 没人用, 不预测
  if (x.freshVerified <= 0) return { exhaustedInDays: 0, sustainable: false }; // 已经枯竭
  if (net <= 0) return { exhaustedInDays: null, sustainable: true };
  return { exhaustedInDays: Math.floor(x.freshVerified / net), sustainable: false };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 「够用多久才算能投放」的地平线（天）。30 天 = 一个排产周期的量级 */
export const ALLOCATION_HORIZON_DAYS = 30;

/**
 * 这个学科池**现在能不能接排产**。
 *
 * 🔴 判据是「**排除明确不可持续的**」，不是「只要明确可持续的」——
 * 这两个集合**不互补**，中间隔着一大批「还没数据」的（`dailyUsage = 0`，
 * 既没被证明健康也没被证明不行）。用后者会把从没用过的大池子一并排除掉。
 *
 * 排除两类：
 *   · `freshVerified === 0` —— 现在就没得选（education 就是这样）
 *   · `exhaustedInDays` 有值且 < 地平线 —— 有实测消耗且很快见底
 *
 * `exhaustedInDays === null` 表示「不预测」（零使用 或 回补跟得上），
 * 两种都不构成排除理由：**没有证据说明它不行，不等于有证据说明它不行。**
 */
export function isViableForAllocation(
  row: Pick<PoolInventoryRow, "freshVerified" | "exhaustedInDays">,
  horizonDays: number = ALLOCATION_HORIZON_DAYS,
): boolean {
  if (row.freshVerified <= 0) return false;
  if (row.exhaustedInDays !== null && row.exhaustedInDays < horizonDays) return false;
  return true;
}

// ============ 消费方 ①: 每日简报 ============

/** 与 daily-briefing 的 BriefItem 结构兼容(刻意不 import 它: 简报文件另一条线在改, 少一个耦合点) */
export interface PoolBriefItem {
  level: "warn" | "alert" | "info";
  text: string;
}

/**
 * 余量 → 简报条目。**文案要运营能行动**: 说清"几本 / 几天 / 到时会怎样 / 你可以做什么",
 * 不写"pool exhausted"这种只有技术看得懂的话。
 *
 * 分级: freshVerified=0(今天就在降级) = 红; 其余 = 黄。
 */
export function renderPoolBriefItems(
  inv: PoolInventory,
  maxItems = 3,
): { items: PoolBriefItem[]; todos: string[] } {
  const items: PoolBriefItem[] = [];
  const todos: string[] = [];
  if (inv.alerts.length === 0) return { items, todos };

  for (const r of inv.alerts.slice(0, maxItems)) {
    const who = `${disciplineCn(r.disciplineCode)}(${SCOPE_CN[r.scope] ?? r.scope})`;
    const when = r.freshVerified === 0
      ? "现在已经没有可选新刊了"
      : r.exhaustedInDays !== null
        ? `按当前用量约 ${r.exhaustedInDays} 天后枯竭`
        : `按当前用量很快见底`;
    const cushion = r.genericFreshVerified > 0
      ? `暂由 ${r.genericFreshVerified} 本综合刊顶着`
      : `连综合刊也没有新的了`;
    items.push({
      level: r.freshVerified === 0 ? "alert" : "warn",
      text:
        `${r.freshVerified === 0 ? "🔴" : "🟡"} ${who}可选池只剩 ${r.freshVerified} 本，${when}(${cushion})。\n` +
        `　　—— 到时该学科内容会开始重复或串到别的学科。\n` +
        `　　可选：到「期刊库」补该学科期刊数据 / 到「内容工坊」减少该学科排产`,
    });
  }
  if (inv.alerts.length > maxItems) {
    items.push({
      level: "warn",
      text: `另有 ${inv.alerts.length - maxItems} 个学科的期刊池也低于水位线(余量 ≤ ${inv.thresholds.lowCount} 本或 ≤ ${inv.thresholds.lowDays} 天) —— 完整余量表见 GET /journals/pool-health。`,
    });
  }
  const worst = inv.alerts[0];
  todos.push(
    `补期刊数据: ${disciplineCn(worst.disciplineCode)}(${SCOPE_CN[worst.scope] ?? worst.scope})只剩 ${worst.freshVerified} 本可选` +
    (inv.alerts.length > 1 ? `, 另有 ${inv.alerts.length - 1} 个学科同样告急` : ""),
  );
  return { items, todos };
}

/**
 * 简报采集入口。**绝不抛错** —— 盘点是观测, 观测失败不能把简报搞挂(与 recordIncident 同一条铁律)。
 */
export async function collectPoolBriefing(tenantId: string): Promise<{ items: PoolBriefItem[]; todos: string[] }> {
  try {
    const inv = await getPoolInventory({ tenantId });
    return renderPoolBriefItems(inv);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "简报: 期刊池盘点失败(跳过, 不影响其余条目)");
    return { items: [], todos: [] };
  }
}
