/**
 * 7-28 ①a: 选刊降级的**结果侧**观测。
 *
 * 为什么不在 pickScopedFreshJournal 的分层里插日志/告警(那是最直接的写法):
 *   ① 那段分层 SQL 正在被另一条线同时改动(期刊可见性/层门槛), 在里面加行等于制造合并冲突;
 *   ② 更重要的是 —— **观测结果比观测代码路径更耐改**。层数、顺序、门槛都会随产品演进变,
 *      但"这次选到的刊是不是回头刊 / 是不是对口"这两个事实的口径永远不变。
 *      分层怎么重排都不用回来改这里。
 *
 * 判据(与 pickScopedFreshJournal 的 fresh / discExact 同源, 只是换成事后查):
 *   - staleReuse: 该刊在本租户 JOURNAL_REUSE_COOLDOWN_DAYS 天内用过 → 破了冷却承诺 = 层⑤⑥以下
 *   - offTopic:   该刊学科码既不是目标学科、也不是 generic(综合刊) → 层⑨⑩ 的"宁不对口不空名额"
 *   任一为真 = 降级到了第 ⑤ 层以下, **这是"某学科刊快用完了"的直接证据**, 该落 incident。
 *   (fresh + generic 综合刊是层②④ 的正常兜底, 不算降级, 不报 —— 报了只会天天刷屏。)
 *
 * 调用时机铁律: **必须在写 journal_usage 占位行之前调**, 否则刚写的那行会把自己算成"回头刊"。
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { journals, journalUsage } from "../../models/schema.js";
import { GENERIC_DISCIPLINE_CODE } from "./discipline-mapping.js";

/** 与 daily-cron 的 JOURNAL_COOLDOWN_DAYS 同一个 env, 同一个默认值(15) */
function cooldownDays(): number {
  const n = Number(process.env.JOURNAL_REUSE_COOLDOWN_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
}

export interface PickDegrade {
  /** 破了 15 天冷却(回头刊) */
  staleReuse: boolean;
  /** 学科不对口(既非目标学科也非综合刊) */
  offTopic: boolean;
  /** 实际学科码(排查用) */
  disciplineCode: string | null;
  /** 距上次使用天数(null = 从没用过) */
  daysSinceLastUse: number | null;
  /** staleReuse || offTopic —— 即"降级到第 ⑤ 层以下" */
  degraded: boolean;
}

const NO_DEGRADE: PickDegrade = {
  staleReuse: false, offTopic: false, disciplineCode: null, daysSinceLastUse: null, degraded: false,
};

/**
 * 判断本次选中的刊是否属于"降级选出"。
 * **绝不抛错**: 观测失败只当作"没降级"(宁可漏报也不能因为一次告警查询把每日排产打挂)。
 */
export async function classifyPickDegrade(
  tenantId: string,
  journalId: string,
  wantedDiscipline: string,
): Promise<PickDegrade> {
  try {
    const [row] = await db
      .select({
        disciplineCode: journals.disciplineCode,
        lastUsedAt: sql<Date | null>`(SELECT max(ju.used_at) FROM ${journalUsage} ju
          WHERE ju.journal_id = ${journals.id} AND ju.tenant_id = ${tenantId})`,
      })
      .from(journals)
      .where(eq(journals.id, journalId))
      .limit(1);
    if (!row) return NO_DEGRADE;

    const code = row.disciplineCode ?? null;
    const offTopic = !!code && code !== wantedDiscipline && code !== GENERIC_DISCIPLINE_CODE;
    const last = row.lastUsedAt ? new Date(row.lastUsedAt as unknown as string) : null;
    const daysSinceLastUse = last ? Math.floor((Date.now() - last.getTime()) / 86_400_000) : null;
    const staleReuse = daysSinceLastUse !== null && daysSinceLastUse < cooldownDays();

    return { staleReuse, offTopic, disciplineCode: code, daysSinceLastUse, degraded: staleReuse || offTopic };
  } catch {
    return NO_DEGRADE;
  }
}

/** 仅为可读性: 把降级事实翻成一句人话(进 incident.message, 简报直接念) */
export function describePickDegrade(scope: string, discipline: string, d: PickDegrade): string {
  const scopeCn = scope === "domestic" ? "国内核心" : scope === "international" ? "国外期刊" : scope;
  const parts: string[] = [];
  if (d.staleReuse) parts.push(`破 ${cooldownDays()} 天冷却重复用刊(距上次 ${d.daysSinceLastUse} 天)`);
  if (d.offTopic) parts.push(`选到不对口学科刊(实际 ${d.disciplineCode ?? "未知"})`);
  // 说清"这不是 bug 是没料了" —— 运营看到这条要做的是补刊/降配额, 不是找技术
  return `选刊降级[${scopeCn}·${discipline}]: ${parts.join(" + ")} —— 该学科可用新刊接近枯竭`;
}
