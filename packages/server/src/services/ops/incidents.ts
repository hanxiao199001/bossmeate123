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
  | "enrich_writeback_rejected" // 期刊回写被合理性护栏拒绝(多为上游 LetPub 解析漂移)
  // ---- 7-27 事故后补的五类: 当天 49 次 AI 超时 + 20 条评分 0 分, ops_incidents 一条都没有 ----
  | "llm_timeout"               // AI 调用超时/中断(This operation was aborted) —— 高频, 走节流
  | "quality_check_timeout"     // 六维质检主模型超时/没响应(该篇随后走降级重试)
  | "quality_check_degraded"    // 六维质检的分是**降级模型**给的(分数可用, 但可信度待审计)
  | "quality_check_unavailable" // 主模型 + 降级模型都失败 → 这篇**没评上分**(≠ 评了 0 分)
  | "output_unhealthy"          // 出稿健康闸拦下明显废稿(占位文/截断/复读/过短)
  | "llm_cost_cap"              // LLM 日花费/调用硬上限熔断(billing/llm-guard.ts, 已停止生成类调用)
  // ---- 7-28 ①目标闭环: 17 个"跳过点"此前只有一行 logger, 没人看 = 等于不存在 ----
  //   命名口径: 说清"哪一步没达成", 而不是"哪个函数返回了 null"。简报直接照着 KIND_LABEL 念。
  | "low_output"                // 今日产出低于目标(未到 60%) —— 零产出的"温水"版本, 原来完全静默
  | "no_topic_available"        // 选不出可用新选题(候选池枯竭/全在冷却)
  | "no_journal_available"      // 某定位+学科选不出任何刊 → 该名额直接空转
  | "journal_pool_exhausted"    // 选到的是回头刊(破 15 天冷却)或不对口刊 = 该学科刊快用完了
  | "candidate_skipped"         // 候选被学科配额/期刊限流大量跳过, 导致未达目标(旧按学科链路)
  | "generation_failed"         // 单篇生成失败(排产环节, 非质检)
  | "draft_shortfall"           // 公众号未达每日保底(草稿分发缺口)
  | "draft_remedy_failed"       // 缺口自动补救本身失败
  | "quality_gate_unavailable"  // 质检闸"没能跑成"(规则检索/红线解析/一致性检查异常) ≠ 内容违规
  // ---- 7-28 阶段1-C Prompt 治理 ----
  | "prompt_contradiction";     // prompt 里同一字段既被要求写又被禁止写(LLM 只能编 → 被防编造闸拦下)

export const KIND_LABEL: Record<string, string> = {
  ledger_write_failed: "记账失败(钱花了没记上账)",
  llm_quota: "AI 额度不足/欠费",
  zero_output: "每日生成零产出",
  briefing_push_failed: "简报推送失败",
  supplier_balance_low: "供应商余额偏低",
  spend_flatline: "消耗骤停(疑似欠费)",
  enrich_writeback_rejected: "期刊数据回写被拒(疑似上游解析失效)",
  llm_timeout: "AI 调用超时(等不到模型返回)",
  quality_check_timeout: "六维质检超时(主模型没响应, 已自动换快模型重评)",
  quality_check_degraded: "六维质检降级出分(分数来自备用快模型, 可信度待抽检)",
  quality_check_unavailable: "六维质检不可用(这篇没评上分, 转人工复核)",
  output_unhealthy: "出稿健康闸拦截(占位文/截断/复读等废稿)",
  llm_cost_cap: "LLM 日上限熔断(已停止内容生成, 客服不受影响)",
  low_output: "今日产出低于目标(没停产, 但明显不够)",
  no_topic_available: "选不出可用选题(候选词枯竭/全在冷却)",
  no_journal_available: "选不出可用期刊(该定位+学科名额空转)",
  journal_pool_exhausted: "期刊池告急(只能用回头刊/不对口刊)",
  candidate_skipped: "候选被配额/限流大量跳过(没凑够篇数)",
  generation_failed: "单篇生成失败(排产环节)",
  draft_shortfall: "公众号未达每日保底(草稿分发缺口)",
  draft_remedy_failed: "草稿缺口自动补救失败",
  quality_gate_unavailable: "质检闸不可用(没检查成, 已转人工; ≠ 内容违规)",
  prompt_contradiction: "prompt 指令自相矛盾(同一字段既要求写又禁止写, 已自动修正; 需回看代码)",
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

// ============ 7-27: 节流版记录(高频失败专用) ============

/**
 * 进程内节流窗口。默认 10 分钟 —— 与 springer-journal-fetcher 的拒写告警同一档
 * (那里的注释解释了为什么: 上游一坏就每篇都命中, 不限速会把 ops_incidents 刷屏, 把别的告警淹了)。
 */
export const INCIDENT_THROTTLE_MS = 10 * 60_000;

interface ThrottleState { lastAt: number; suppressed: number }
const throttleByKey = new Map<string, ThrottleState>();

/** 仅供单测重置节流状态(线上没有调用方) */
export function __resetIncidentThrottle(): void {
  throttleByKey.clear();
}

/**
 * 节流版 recordIncident: 同一 key 在窗口内只落一条, 被压掉的次数带在
 * detail.suppressedSinceLastAlert 里(信息不丢, 只是不逐条落库)。
 *
 * 用在**一次故障会连锁触发几十上百次**的点(AI 超时: 7-27 当天 49 次)。
 * 反过来, "一次事件 = 一篇内容被毙"这种点**不要**用它 —— 那里的条数本身就是要看的量
 * (如 quality_check_timeout: 条数 = 今天有几篇内容没能进草稿箱)。
 *
 * @param key 节流粒度。默认按 kind; 想按 provider/租户分别节流就自己拼。
 */
export async function recordIncidentThrottled(
  input: RecordIncidentInput,
  opts?: { key?: string; cooldownMs?: number },
): Promise<{ recorded: boolean }> {
  const key = opts?.key ?? String(input.kind);
  const cooldown = opts?.cooldownMs ?? INCIDENT_THROTTLE_MS;
  const now = Date.now();
  const st = throttleByKey.get(key);
  if (st && now - st.lastAt < cooldown) {
    st.suppressed += 1;
    return { recorded: false };
  }
  const suppressed = st?.suppressed ?? 0;
  throttleByKey.set(key, { lastAt: now, suppressed: 0 });
  await recordIncident({
    ...input,
    detail: { ...(input.detail ?? {}), suppressedSinceLastAlert: suppressed },
  });
  return { recorded: true };
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

/**
 * 7-27: 判定一次调用失败是否属于"超时/被中断"类。
 *
 * 由来: 7-27 线上 49 次 `This operation was aborted`(AbortController 到点掐断 fetch),
 *   一条 incident 都没有 —— 六维质检因此大面积拿不到分, 只能靠人肉翻日志才发现。
 *   AI 超时是**成本与产能**双杀的信号(钱花了、内容没出来), 必须能被简报报出来。
 *
 * 刻意**不含** 4xx/5xx 业务错误 —— 那些由 llm_quota / 调用方各自的日志覆盖, 混进来会稀释信号。
 */
export function isTimeoutLikeError(err: unknown): boolean {
  const msg = (err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  const KEYWORDS = [
    "aborted",          // undici: This operation was aborted
    "abort",            // AbortError
    "timeout",
    "timed out",
    "etimedout",
    "esockettimedout",
    "econnreset",
    "socket hang up",
    "超时",
  ];
  return KEYWORDS.some((k) => msg.includes(k));
}
