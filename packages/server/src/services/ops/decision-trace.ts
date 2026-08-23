/**
 * 决策留痕（8-17，第一批：选刊链路）。**纯观测，零行为变更。**
 *
 * ## 为什么要有它
 *
 * 追查「education 期刊每天被消耗 14 本」时，静态读代码只追到 5 本
 * （domestic 1 + international 1 + roundup 3），**剩下 9 本追不出来**。
 * 在此之前还先按 `journal_usage` 行数推出过一个错数（17.9，实际被重试重复插入抬高了）。
 *
 * > 一条内容为什么用了这本刊，答案只存在于「当时那次运行的控制流」里，跑完就没了。
 * > 人肉考古能追到一半，另一半只能靠猜 —— 而猜出来的数会被当成事实用下去。
 *
 * ## 🔴 必须同时记「意图」和「结果」
 *
 * 只记选中的话，某条路径完全没有记录时，我们分不清是
 * **「这条路没跑」** 还是 **「跑了但没接留痕」**。
 * 所以每个入口在**调用选刊之前**先记一条 intent，选完再记 consumption；
 * 两者对不上的就是漏接的路径 —— 这是「接线完整性检查」的运行时版本
 * （台账那次是编译期版本：闸有 10 个 code 而只接了 9 个）。
 *
 * 配套：`requestedBy` 默认 `"unknown"`。没传上下文的调用会以 unknown 现身，
 * 那正是要抓的东西 —— **留痕装在选刊器内部，谁调用都记**。
 *
 * ## 🔴 两个学科口径都对，但绝不能互换
 *
 * ```
 * 余量按刊学科(供给侧)     journalDiscipline —— pool-inventory 用它
 * 配额按槽位学科(需求侧)   slotDiscipline    —— 学科配额闸用它
 * ```
 *
 * generic 通配刊被 education 槽位选中时，**消耗的是 education 的配额、
 * 减少的是 generic 池的余量**。若配额改按刊学科计，1139 本 generic 刊
 * 就成了绕过所有学科配额的公共后门（`discipline-mapping.ts:34` 写着
 * 「在任何学科槽位都算命中」—— 那是设计，不是 bug，但它决定了配额只能按需求方计）。
 *
 * ## 表的口径（明早那张表的定义，先定死免得误读）
 *
 * **一行 consumption = 一次期刊消耗** —— 不是一篇内容，也不是一次请求。
 * roundup 一篇用 3 本刊 = 3 行；重试不重复计（`batch_row_id` 幂等已上，migration 035）。
 * （对照：台账那次「评估 841 次 vs 出稿 191 篇」的误读，就是行的定义没先说清。）
 */
import { and, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../models/db.js";
import { decisionTraces } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

/** 决策点。第一批只上选刊 */
export type DecisionPoint = "journal_pick";

/** 谁在请求。`unknown` = 调用方没传 = 漏接的路径 */
export type RequestedBy =
  | "daily_cron_article"
  | "daily_cron_roundup"
  | "admin_roundup"
  | "batch"
  | "unknown";

/** 降级链的一环。**数组**结构 —— 选刊是两层嵌套（选题放宽 × 选刊分层），日后可能更多 */
export interface FallbackStep {
  /** 哪一层降级机制，如 "selection"(选题条件放宽) / "journal_tier"(选刊十层) */
  layer: string;
  /** 落在第几档 */
  tier: number;
  /** 原因码 —— **不用自由文本**，"因为它最合适"这种记录等于没记 */
  reason: string;
}

export interface PickIntent {
  requestedBy: RequestedBy;
  /** 需求侧学科（配额按它计） */
  slotDiscipline: string | null;
  scope?: string | null;
  tenantId?: string | null;
}

export interface PickConsumption extends PickIntent {
  correlationId: string;
  journalId: string;
  /** 供给侧学科（余量按它算） */
  journalDiscipline: string | null;
  contentId?: string | null;
  fallback?: FallbackStep[];
  /** 是否落到 generic 通配兜底 */
  genericWildcard?: boolean;
}

/**
 * 记一次「我要请求选刊了」。**在调用选刊器之前调。**
 *
 * 返回 correlationId —— 后面的 consumption 用它串起来。
 * 失败只记日志不抛错：留痕挂了不该让内容生产跟着挂。
 */
export async function traceJournalIntent(input: PickIntent): Promise<string> {
  const correlationId = randomUUID();
  try {
    await db.insert(decisionTraces).values({
      point: "journal_pick",
      phase: "intent",
      correlationId,
      requestedBy: input.requestedBy,
      slotDiscipline: input.slotDiscipline,
      scope: input.scope ?? null,
      tenantId: input.tenantId ?? null,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "decision_trace.intent_failed");
  }
  return correlationId;
}

/** 记一次真实的期刊消耗。**一本刊一行。** */
export async function traceJournalConsumption(input: PickConsumption): Promise<void> {
  try {
    await db.insert(decisionTraces).values({
      point: "journal_pick",
      phase: "consumption",
      correlationId: input.correlationId,
      requestedBy: input.requestedBy,
      slotDiscipline: input.slotDiscipline,
      journalDiscipline: input.journalDiscipline,
      scope: input.scope ?? null,
      journalId: input.journalId,
      contentId: input.contentId ?? null,
      fallback: input.fallback ?? [],
      genericWildcard: input.genericWildcard ?? false,
      tenantId: input.tenantId ?? null,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "decision_trace.consumption_failed");
  }
}

/**
 * 明早那张表。**每行 = 一次期刊消耗。**
 *
 * 同时给出 intent 与 consumption 的对账：对不上的路径就是漏接的
 * （或者真的没跑 —— 但至少这两种情况现在能分开了）。
 */
export async function journalConsumptionReport(hours = 24): Promise<string> {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const rows = (await db
    .select({
      requestedBy: decisionTraces.requestedBy,
      phase: decisionTraces.phase,
      slot: decisionTraces.slotDiscipline,
      jdisc: decisionTraces.journalDiscipline,
      generic: decisionTraces.genericWildcard,
      n: sql<number>`count(*)::int`,
    })
    .from(decisionTraces)
    .where(and(gte(decisionTraces.createdAt, since), sql`${decisionTraces.point} = 'journal_pick'`))
    .groupBy(
      decisionTraces.requestedBy,
      decisionTraces.phase,
      decisionTraces.slotDiscipline,
      decisionTraces.journalDiscipline,
      decisionTraces.genericWildcard,
    )) as Array<Record<string, unknown>>;

  const L: string[] = [];
  L.push(`【选刊决策留痕】近 ${hours} 小时`);
  L.push("口径：**一行 = 一次期刊消耗**（不是一篇内容、不是一次请求）。");
  L.push("      roundup 一篇用 3 本刊 = 3 行；重试不重复计（batch_row_id 幂等）。");
  L.push("");

  const cons = rows.filter((r) => r.phase === "consumption");
  const intents = rows.filter((r) => r.phase === "intent");
  const sum = (rs: typeof rows) => rs.reduce((a, r) => a + Number(r.n ?? 0), 0);

  L.push(`■ 消耗合计 ${sum(cons)} 本 ｜ 意图合计 ${sum(intents)} 次`);
  L.push("");
  L.push("■ 按请求方（unknown = 漏接留痕的路径）");
  const byReq = new Map<string, { intent: number; cons: number }>();
  for (const r of rows) {
    const k = String(r.requestedBy);
    const e = byReq.get(k) ?? { intent: 0, cons: 0 };
    if (r.phase === "intent") e.intent += Number(r.n ?? 0);
    else e.cons += Number(r.n ?? 0);
    byReq.set(k, e);
  }
  for (const [k, v] of [...byReq.entries()].sort((a, b) => b[1].cons - a[1].cons)) {
    const flag = k === "unknown" ? "  🔴 漏接" : v.intent === 0 && v.cons > 0 ? "  ⚠️ 有消耗无意图" : "";
    L.push(`  ${k.padEnd(22)} 意图 ${String(v.intent).padStart(4)} ｜ 消耗 ${String(v.cons).padStart(4)}${flag}`);
  }

  L.push("");
  L.push("■ 需求侧 vs 供给侧（两个口径都列，绝不能互换）");
  const bySlot = new Map<string, number>();
  const byJournal = new Map<string, number>();
  let genericN = 0;
  for (const r of cons) {
    const n = Number(r.n ?? 0);
    bySlot.set(String(r.slot ?? "(未记)"), (bySlot.get(String(r.slot ?? "(未记)")) ?? 0) + n);
    byJournal.set(String(r.jdisc ?? "(未记)"), (byJournal.get(String(r.jdisc ?? "(未记)")) ?? 0) + n);
    if (r.generic) genericN += n;
  }
  L.push("  槽位学科（配额按它计）：" + [...bySlot.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
  L.push("  刊的学科（余量按它算）：" + [...byJournal.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
  L.push(`  其中走 generic 通配兜底：${genericN} 本` + (genericN > 0 ? "  ← 这些消耗的是槽位学科的配额，不是 generic 的" : ""));

  return L.join("\n");
}

/**
 * 批量记消耗（**一本刊一行**）。
 *
 * 顺带把每本刊的 `discipline_code`（供给侧）查出来一起记 ——
 * 只记槽位学科的话，「generic 通配刊被 education 槽位选中」这件事就看不见了，
 * 而它正是配额后门的形态。
 */
export async function traceJournalConsumptionBatch(
  journalIds: string[],
  ctx: Omit<PickConsumption, "correlationId" | "journalId" | "journalDiscipline">
    & {
      /**
       * 8-23：由调用方传入，与它那次 `traceJournalIntent` 串起来。
       *
       * 不传就自己生成一个（旧行为）—— 但那样 intent 与 consumption **永远配不上对**，
       * 于是「想选 3 本、实际只拿到 2 本」这类**选不出刊的失败**在留痕里完全不可见：
       * 消耗侧只记成功拿到的那些，失败的那一本不会留下任何痕迹。
       *
       * 实测（8-23）：`daily_cron_article` intent 126 / consumption 126（成对），
       * 而 `daily_cron_roundup` intent **0** / consumption 36 —— 只有一半。
       */
      correlationId?: string;
    },
): Promise<void> {
  if (journalIds.length === 0) return;
  try {
    const { journals } = await import("../../models/schema.js");
    const { inArray } = await import("drizzle-orm");
    const rows = await db
      .select({ id: journals.id, disc: journals.disciplineCode })
      .from(journals)
      .where(inArray(journals.id, journalIds));
    const discOf = new Map(rows.map((r) => [r.id, r.disc]));
    const correlationId = ctx.correlationId ?? randomUUID();
    for (const jid of journalIds) {
      const jd = discOf.get(jid) ?? null;
      await traceJournalConsumption({
        ...ctx,
        correlationId,
        journalId: jid,
        journalDiscipline: jd,
        // generic 刊在任何学科槽位都算命中 —— 落到它就是一次通配兜底
        genericWildcard: jd === "generic" && ctx.slotDiscipline !== "generic",
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "decision_trace.batch_failed");
  }
}
