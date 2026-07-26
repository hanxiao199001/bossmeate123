/**
 * 7-25 运维告警①: 异常事件流水 (ops_incidents)
 *
 * 背景: 系统里一堆"失败了但只 logger.error/warn"的点 —— 记账失败(cost-ledger.ts)、
 * LLM 额度不足、每日生成零产出、企微推送失败。日志没人天天看, 于是系统静默停摆几天没人知道。
 * 本模块把这些点落库, 由 daily-briefing 汇总成一条运营能看懂的简报。
 *
 * 铁律(与 recordCost 同源): **recordIncident 绝不抛错**。告警链路自己挂了不能反过来搞挂业务。
 * DB 也不通时只剩日志 —— 这是可接受的最后兜底(此时 /health/ping 会 503, 外部拨测会喊)。
 */
import { and, desc, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { opsIncidents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

/** 事件类型 —— 新增类型时同步更新 KIND_LABEL, 否则简报里只显示原始 kind */
export type IncidentKind =
  | "ledger_write_failed"   // cost_ledger 写入失败(钱花了没记上账)
  | "llm_quota"             // LLM 返回额度不足/欠费类错误
  | "zero_output"           // 每日生成零产出
  | "briefing_push_failed"  // 每日简报企微推送失败
  | "supplier_balance_low"  // 供应商余额低于阈值
  | "spend_flatline"        // 消耗骤降到 0(疑似欠费/额度耗尽)
  | "enrich_writeback_rejected"; // 期刊回写被合理性护栏拒绝(多为上游 LetPub 解析漂移)

export const KIND_LABEL: Record<string, string> = {
  ledger_write_failed: "记账失败(钱花了没记上账)",
  llm_quota: "AI 额度不足/欠费",
  zero_output: "每日生成零产出",
  briefing_push_failed: "简报推送失败",
  supplier_balance_low: "供应商余额偏低",
  spend_flatline: "消耗骤停(疑似欠费)",
  enrich_writeback_rejected: "期刊数据回写被拒(疑似上游解析失效)",
};

export interface RecordIncidentInput {
  kind: IncidentKind | string;
  message: string;
  /** 平台级故障(如 LLM 额度)可不带租户 */
  tenantId?: string | null;
  severity?: "error" | "warn";
  detail?: Record<string, unknown> | null;
}

/** UUID 粗校验 —— tenantId 传了非 uuid(如 "system"/"") 会被外键打回, 宁可记成平台级也不报错 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 记一条异常事件。绝不抛错。 */
export async function recordIncident(input: RecordIncidentInput): Promise<void> {
  try {
    await db.insert(opsIncidents).values({
      tenantId: input.tenantId && UUID_RE.test(input.tenantId) ? input.tenantId : null,
      kind: String(input.kind).slice(0, 40),
      severity: input.severity === "warn" ? "warn" : "error",
      message: String(input.message).slice(0, 500),
      detail: input.detail ?? null,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, kind: input.kind, message: input.message },
      "ops_incidents.record_failed — 告警落库失败, 该异常只剩本条日志",
    );
  }
}

export interface IncidentCount {
  kind: string;
  count: number;
  lastMessage: string;
  lastAt: Date | string;
}

/**
 * 近 N 小时的事件按 kind 聚合 (跨租户: 运维视角看的是整台机器)。
 * 简报要的是"哪类问题出了几次 + 最后一条长什么样", 不是逐条流水。
 */
export async function getIncidentSummary(hours = 24): Promise<IncidentCount[]> {
  const since = new Date(Date.now() - Math.max(1, hours) * 3600_000);
  try {
    const rows = await db
      .select({
        kind: opsIncidents.kind,
        count: sql<number>`count(*)::int`,
        lastMessage: sql<string>`(array_agg(${opsIncidents.message} ORDER BY ${opsIncidents.createdAt} DESC))[1]`,
        lastAt: sql<Date>`max(${opsIncidents.createdAt})`,
      })
      .from(opsIncidents)
      .where(gte(opsIncidents.createdAt, since))
      .groupBy(opsIncidents.kind)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({
      kind: r.kind,
      count: Number(r.count ?? 0),
      lastMessage: r.lastMessage ?? "",
      lastAt: r.lastAt,
    }));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "ops_incidents 聚合失败, 简报该项留空");
    return [];
  }
}

/** 某一类事件近 N 小时出现几次 (供应商余额判定用) */
export async function countIncidents(kind: string, hours = 24): Promise<number> {
  const since = new Date(Date.now() - Math.max(1, hours) * 3600_000);
  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(opsIncidents)
      .where(and(gte(opsIncidents.createdAt, since), sql`${opsIncidents.kind} = ${kind}`));
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

// ============ LLM 额度不足信号 (纯函数, 无 IO — 直接单测) ============

/**
 * 判定一次 LLM/云 API 失败是否属于"额度不足 / 欠费 / 未开通"类。
 * 这是"该充值了"的最直接信号 —— 比等消耗曲线掉到 0 早一步。
 *
 * 覆盖: OpenAI 兼容(DeepSeek/百炼 compatible-mode) + 阿里云百炼原生错误码 + HTTP 402。
 * 刻意不含 429 纯限流(Requests per minute 是流控不是欠费), 但含 DashScope 的
 * Throttling.AllocationQuota(免费额度用尽会走这个码)。
 */
export function isQuotaLikeError(status: number, body: string | null | undefined): boolean {
  if (status === 402) return true; // Payment Required
  const t = (body ?? "").toLowerCase();
  if (!t) return false;
  const KEYWORDS = [
    "insufficient_quota",
    "insufficient balance",
    "insufficientbalance",
    "insufficient_user_quota",
    "exceeded your current quota",
    "allocated quota exceeded",
    "allocationquota",
    "quota exhausted",
    "quota_exceeded",
    "arrears",
    "account is overdue",
    "accessdenied.unpurchased",
    "free allocated quota exceeded",
    "余额不足",
    "额度不足",
    "欠费",
    "已用完",
    "未开通",
  ];
  return KEYWORDS.some((k) => t.includes(k));
}
