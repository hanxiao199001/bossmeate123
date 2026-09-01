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

/**
 * 8-03: 三个纯判据(isQuotaLikeError / isTimeoutLikeError / classifyFailure)已搬到
 * services/ops/failure-kind.ts —— 那里零依赖, 而本文件依赖 db。
 *
 * 【为什么要搬】新增的失败分类是**整套自动重跑的地基**, 会被 batch-worker / 质检 / DVH /
 *   探测器四条链路引用; 若判据留在本文件, 这四处就都得连带把数据库拉进来(单测也要 mock db)。
 * 【为什么在这里 re-export】原来的 `import { isQuotaLikeError } from "../ops/incidents.js"`
 *   有 5 个调用点 + 2 个测试文件, 全部保持可用, 零改动面。新代码建议直接从 failure-kind.js 引。
 */
export {
  isQuotaLikeError,
  isTimeoutLikeError,
  classifyFailure,
  isRetriableFailure,
  extractErrorFields,
  parseProviderErrorBody,
  FAILURE_KIND_LABEL,
} from "./failure-kind.js";
export type { FailureKind, ProviderErrorFields } from "./failure-kind.js";

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
  // ---- 7-30 感知①: 与上面那条是**同一件事的两个时点**, 刻意分成两个 kind ----
  //   exhausted = 事后实锤(已经降级了); forecast = 排产**前**就算出来"这几篇注定要降级"。
  //   合成一个的话, "今天注定要降级"会被"今天已经降级了"的计数吞掉, 简报也分不清哪条是预警。
  | "journal_pool_forecast"     // 排产前盘点发现: 某学科可选新刊为 0, 而今天还要给它排产
  | "candidate_skipped"         // 候选被学科配额/期刊限流大量跳过, 导致未达目标(旧按学科链路)
  | "generation_failed"         // 单篇生成失败(排产环节, 非质检)
  | "draft_shortfall"           // 公众号未达每日保底(草稿分发缺口) —— 水位波动，每天都可能响
  | "account_supply_starved"    // 8-22: 某号连续多日零进箱 —— 是**故障**，与上面那条刻意分开
                                //   (实测 Paper咨询与发表 断供 25 天，被每天都在响的 draft_shortfall 淹没)
  | "account_supply_check_failed" // 8-23: 上面那条检查**自己挂了** —— 与"没有断供的号"必须可区分(红线 #23)
  | "draft_remedy_failed"       // 缺口自动补救本身失败
  | "quality_gate_unavailable"  // 质检闸"没能跑成"(规则检索/红线解析/一致性检查异常) ≠ 内容违规
  // ---- 7-28 阶段1-C Prompt 治理 ----
  | "prompt_contradiction"      // prompt 里同一字段既被要求写又被禁止写(LLM 只能编 → 被防编造闸拦下)
  // ---- 7-31 数字人(DVH): 四种"出片了但不是真出片", 此前全部只有一行 logger ----
  //   共同点: 运营界面上都显示"生成成功"、内容管理里也确实躺着一条视频, 只有日志里那行
  //   区分得出真假。日志没人天天看 = 等于没有 → 全部落库上简报。
  //   按"钱"分档: orphaned 已扣费拿不到货(最贵), submit_failed/tts_failed 未扣费(白干),
  //   mock_mode 是配置事故(一开就整天全是占位片)。
  | "dvh_paid_task_orphaned"    // 已扣费但拿不到成片(submit 成功, query 失败/超时) —— 钱花了没货
  | "dvh_submit_failed"         // 提交阿里云就失败(未扣费), 落库的是占位样片非真渲染
  | "dvh_tts_failed"            // TTS 合成失败, 已**主动中止**提交(未扣费; 提交了必是哑巴视频)
  | "dvh_mock_mode"
  // ---- 8-02 生成结果闭环: 入队了但没生出来 ----
  | "generation_pipeline_unhealthy"            // DVH_REAL_MODE 未开: 本条是固定占位样片, 形象/背景/音色一律不生效
  // ---- 8-03 失败分类 + 服务恢复自动重跑(见 failure-kind.ts / deferred.ts / service-health-probe.ts) ----
  //   四个 kind 讲的是同一条内容的四个时点: 被暂停 → 服务回来了 → 重跑 → 跑不动了转人工。
  //   刻意不合并: 简报要能分清"今天积压了多少"和"今天自动救回了多少", 合成一条就都看不见了。
  | "content_deferred"           // 内容因外部服务不可用被暂停(原始输入已存, 恢复后自动重跑)
  | "service_recovered"          // 探测到外部依赖恢复, 已把积压内容重新入队
  | "deferred_retry_exhausted"   // 自动重跑次数用尽仍失败 → 转人工(别再每 30 分钟烧一次钱)
  | "service_probe_failed";      // 恢复探测本身失败(= 依赖仍未恢复; 连续失败会拉长探测间隔)

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
  journal_pool_forecast: "期刊池预判(开工前就知道该学科没新刊了, 今天这几篇注定重复/串学科)",
  candidate_skipped: "候选被配额/限流大量跳过(没凑够篇数)",
  generation_failed: "单篇生成失败(排产环节)",
  draft_shortfall: "公众号未达每日保底(草稿分发缺口)",
  account_supply_starved: "公众号长期零进箱(疑配对/凭证故障, 非产量问题)",
  account_supply_check_failed: "长期零进箱检查**没跑成**(≠ 没有断供的号)",
  draft_remedy_failed: "草稿缺口自动补救失败",
  quality_gate_unavailable: "质检闸不可用(没检查成, 已转人工; ≠ 内容违规)",
  prompt_contradiction: "prompt 指令自相矛盾(同一字段既要求写又禁止写, 已自动修正; 需回看代码)",
  dvh_paid_task_orphaned: "数字人视频钱花了没拿到货(任务已提交并扣费, 但取不回成片)",
  dvh_submit_failed: "数字人视频提交失败(未扣费, 但界面显示成功、落库的是占位样片)",
  dvh_tts_failed: "数字人配音合成失败(已主动中止, 未扣费; 提交了也必是哑巴视频)",
  dvh_mock_mode: "数字人处于演示模式(DVH_REAL_MODE 未开, 出的全是固定占位样片)",
  // 8-02 自检补: 这个 kind 由 model-router 的启动期自检落库(已出现 5 次), 但一直没有 label,
  //   简报里就直接把英文 kind 念出来, 运营看不懂。
  degenerate_fallback_route: "AI 兜底路由退化(主模型与备用模型是同一个, 主模型一挂即全线停)",
  generation_pipeline_unhealthy: "生成链路异常(进了队列却大批生不出来)",
  content_deferred: "内容已暂停待重跑(外部服务不可用, 原稿已保存, 服务恢复后自动重跑)",
  service_recovered: "外部服务已恢复(积压内容已自动重新入队)",
  deferred_retry_exhausted: "自动重跑次数用尽(已转人工, 不再自动重试)",
  service_probe_failed: "外部服务仍未恢复(恢复探测失败)",
  // 8-26 备份体系。生产此前**零自动备份**, 详见 services/ops/backup.ts 文件头。
  backup_failed: "每日备份失败(今天没有可用备份, 而 03:30 的保留期清理照常会删数据)",
  backup_drill_failed: "恢复演练失败(备份文件在, 但没能证明它能恢复 —— 不算有备份)",
  backup_stale: "备份过期未更新(任务可能压根没在跑 —— 没跑不会产生任何失败告警)",
  backup_ledger_write_failed: "备份台账写入失败(备份新鲜度检查会因此误报)",
  backup_drill_cleanup_failed: "演练库没删掉(每周积累一个全量库会吃满磁盘)",
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

// ============ LLM 额度不足 / 超时 / 失败分类 ============
//
// 8-03 起判据本体在 services/ops/failure-kind.ts(纯函数, 零依赖), 本文件顶部已 re-export。
// 这里刻意不再放判据代码 —— 判据只能有一份, 两份就会像 7-25 的 "arrears" vs "Arrearage" 那样
// 各自漂移, 最后谁也不知道线上真正生效的是哪一份。
