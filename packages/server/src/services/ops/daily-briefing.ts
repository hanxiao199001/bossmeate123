/**
 * 7-25 运维告警①(最实用): 每日运营简报
 *
 * 目标: 让系统自己喊救命。此前所有失败都只进日志, 运营看不见, 系统静默停摆几天没人发现。
 *
 * 设计原则 —— **只报异常和要人动手的, 不报流水账**:
 *   - 红色(alert): 零产出 / AI 额度不足 / 发布卡住 / 预算超限 / DB·Redis 挂 —— 置顶, 要立刻处理
 *   - 黄色(warn) : 产出低于目标 / 账号未达保底 / 转人工积压 / 磁盘队列 degraded —— 今天内看一眼
 *   - 绿色(ok)   : 一行汇总"系统活着"。正常时也发 —— 不发 = 分不清"没事"还是"简报也挂了"
 *
 * 推送: 复用企微 notifyStaff(自建应用 message/send, 已有凭证 + 通知人配置, 见 work-wechat/kf-client.ts)。
 * 降级(必做): 企微未配置 / 推送失败 → 简报**照样落库** ops_briefings + 今日驾驶舱顶部卡片展示,
 *             并额外记一条 ops_incidents(briefing_push_failed)。绝不允许"告警本身也静默失败"。
 *
 * 复用(红线 #11): getSpend(cost-ledger) / getKfStats(kf-stats) / computePublishHealth(matrix-health)
 *                / getMatrixOverview(matrix-overview) / runFullHealthCheck(ops/health-check)
 *                / notifyStaff(kf-client) —— 一行判定逻辑都不重写。
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import {
  agentPublishTasks,
  contentPublishLog,
  contents,
  opsBriefings,
  platformAccounts,
  tenants,
} from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getSpend, type BudgetConfig } from "../billing/cost-ledger.js";
import { getKfStats } from "../work-wechat/kf-stats.js";
import { computePublishHealth, startOfBjDay, type PublishHealth } from "../metrics/matrix-health.js";
import { getMatrixOverview } from "../metrics/matrix-overview.js";
import { notifyStaff } from "../work-wechat/kf-client.js";
import { runFullHealthCheck, type FullHealth } from "./health-check.js";
import { checkSupplierBalance, type SupplierBalanceResult } from "./supplier-balance.js";
import { getIncidentSummary, KIND_LABEL, recordIncident, type IncidentCount } from "./incidents.js";

// ============ 数据结构 ============

export type BriefLevel = "ok" | "warn" | "alert";

export interface BriefItem {
  level: BriefLevel;
  /** 一句人话, 运营直接照做 */
  text: string;
}

export interface TenantBriefing {
  tenantId: string;
  tenantName: string;
  /** 今日生成条数(自己租户 + SYSTEM 共享池, 同今日驾驶舱口径) */
  generatedToday: number;
  /** 今日进公众号草稿箱条数 */
  draftPushedToday: number;
  /** 今日发布成功条数 */
  publishedToday: number;
  /** 未达每号保底的公众号 */
  draftShortfalls: Array<{ accountName: string; pushed: number; target: number }>;
  draftTargetPerAccount: number;
  publishHealth: PublishHealth;
  /** AI 客服: 今日转人工 / 敏感词拦截 */
  kf: { handoffs: number; blockedSensitive: number; customerMessages: number };
  spend: { todayCents: number; monthCents: number; budget: BudgetConfig; usedPct: number | null };
  accounts: { total: number; abnormal: number; byHealth: Record<string, number> };
  items: BriefItem[];
  level: BriefLevel;
}

export interface PlatformBriefing {
  health: FullHealth;
  supplier: SupplierBalanceResult;
  incidents: IncidentCount[];
  items: BriefItem[];
  level: BriefLevel;
}

export interface BriefingResult {
  date: string;
  level: BriefLevel;
  text: string;
  pushed: boolean;
  pushError: string | null;
  tenantsProcessed: number;
}

const LEVEL_RANK: Record<BriefLevel, number> = { ok: 0, warn: 1, alert: 2 };

/** 取一组条目里最严重的等级 */
export function worstLevel(items: Array<{ level: BriefLevel }>): BriefLevel {
  let worst: BriefLevel = "ok";
  for (const i of items) if (LEVEL_RANK[i.level] > LEVEL_RANK[worst]) worst = i.level;
  return worst;
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 北京时间日期串 YYYY-MM-DD */
export function bjDateString(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 企微 message/send 的 text 上限是 **2048 字节**(不是 2048 字符) —— 中文 1 字 3 字节,
 * notifyStaff 里的 text.slice(0, 2000) 按字符切, 中文简报会超字节数被企微整条打回。
 * 这里按字节安全截断(默认 1800 字节留余量), 落库的仍是完整全文。
 */
export function truncateForWecom(text: string, maxBytes = 1800): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  const SUFFIX = "\n…(内容较多, 完整版见「今日驾驶舱」运维简报卡片)";
  const budget = maxBytes - enc.encode(SUFFIX).length;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (bytes + n > budget) break;
    bytes += n;
    out += ch;
  }
  return out + SUFFIX;
}

// ============ 判定 (纯函数, 无 IO — 单测锁行为) ============

export interface TenantSignals {
  generatedToday: number;
  draftPushedToday: number;
  publishedToday: number;
  draftShortfalls: Array<{ accountName: string; pushed: number; target: number }>;
  draftTargetPerAccount: number;
  publishHealth: PublishHealth;
  kf: { handoffs: number; blockedSensitive: number; customerMessages: number };
  spend: { todayCents: number; monthCents: number; budget: BudgetConfig };
  accounts: { total: number; abnormal: number; byHealth: Record<string, number> };
  /** 阈值 */
  minDailyContent: number;
  budgetWarnPct: number;
  handoffWarnCount: number;
}

/** 租户级信号 → 简报条目。**只产出异常与要人动手的**, 正常项由 renderer 折成一行 ✅。 */
export function judgeTenant(s: TenantSignals): { items: BriefItem[]; usedPct: number | null } {
  const items: BriefItem[] = [];

  // ① 内容生成 — 零产出是最高优先级红色(系统停摆的第一信号)
  if (s.generatedToday === 0) {
    items.push({ level: "alert", text: `今日内容生成 0 篇 —— 生成链路可能整条停了。先看 AI 额度是否用尽, 再看服务器日志 daily-recommendation。` });
  } else if (s.generatedToday < s.minDailyContent) {
    items.push({ level: "warn", text: `今日只生成 ${s.generatedToday} 篇(期望 ≥${s.minDailyContent} 篇) —— 多半是可选期刊/选题不够, 到「内容工坊」看看。` });
  }

  // ② 分发保底
  if (s.draftShortfalls.length > 0) {
    const detail = s.draftShortfalls.slice(0, 5).map((x) => `${x.accountName}(${x.pushed}/${x.target})`).join("、");
    const more = s.draftShortfalls.length > 5 ? ` 等 ${s.draftShortfalls.length} 个号` : "";
    items.push({ level: "warn", text: `${s.draftShortfalls.length} 个公众号今日进草稿箱未达保底(${s.draftTargetPerAccount} 篇/天): ${detail}${more} —— 内容不够分, 需提高生成量。` });
  }

  // ③ 发布失败/卡住
  if (s.publishHealth.stuckPending > 0) {
    items.push({ level: "alert", text: `${s.publishHealth.stuckPending} 条发布任务超过 10 分钟没被领取 —— 客户电脑上的发布助手没开机或掉线, 请提醒客户启动。` });
  }
  if (s.publishHealth.loginExpired > 0) {
    items.push({ level: "alert", text: `${s.publishHealth.loginExpired} 条任务登录态失效 —— 到「账号矩阵」重新扫码登录。` });
  }
  if (s.publishHealth.failed > 0) {
    items.push({ level: "warn", text: `${s.publishHealth.failed} 条发布失败 —— 到「今日驾驶舱」看失败原因, 可重派。` });
  }

  // ④ AI 客服
  if (s.kf.handoffs >= s.handoffWarnCount) {
    items.push({ level: "warn", text: `AI 客服今日转人工 ${s.kf.handoffs} 次 —— 到「AI 客服」页看"没答上"清单, 顺手补进 FAQ。` });
  }
  if (s.kf.blockedSensitive > 0) {
    items.push({ level: "warn", text: `敏感词出站拦截 ${s.kf.blockedSensitive} 次 —— 已自动转人工兜底, 建议复核这些问法。` });
  }

  // ⑤ 成本 / 预算
  const daily = s.spend.budget.dailyLimitYuan;
  const usedPct = daily && daily > 0 ? Math.round((s.spend.todayCents / (daily * 100)) * 100) : null;
  if (usedPct !== null && usedPct >= 100) {
    items.push({ level: "alert", text: `今日花费 ${yuan(s.spend.todayCents)} 元, 已用满每日预算 ${daily} 元 —— 预算闸会拒绝后续花钱动作(视频/配音会做不出来), 需调高预算或等明天。` });
  } else if (usedPct !== null && usedPct >= s.budgetWarnPct) {
    items.push({ level: "warn", text: `今日花费 ${yuan(s.spend.todayCents)} 元, 已用掉每日预算的 ${usedPct}% —— 快到闸了。` });
  }
  const monthly = s.spend.budget.monthlyLimitYuan;
  if (monthly && monthly > 0 && s.spend.monthCents >= monthly * 100 * (s.budgetWarnPct / 100)) {
    items.push({ level: "warn", text: `本月已花 ${yuan(s.spend.monthCents)} 元 / 月预算 ${monthly} 元。` });
  }

  // ⑥ 账号异常
  const abnormalDetail = Object.entries(s.accounts.byHealth)
    .filter(([h]) => h !== "healthy" && h !== "disabled" && h !== "no_content_today")
    .map(([h, n]) => `${ACCOUNT_HEALTH_LABEL[h] ?? h} ${n} 个`)
    .join("、");
  if (abnormalDetail) {
    const hasHard = (s.accounts.byHealth.token_invalid ?? 0) > 0 || (s.accounts.byHealth.login_expired ?? 0) > 0;
    items.push({
      level: hasHard ? "alert" : "warn",
      text: `账号异常: ${abnormalDetail} —— 到「账号矩阵」处理(失效的号发不出内容)。`,
    });
  }

  return { items, usedPct };
}

export const ACCOUNT_HEALTH_LABEL: Record<string, string> = {
  login_expired: "登录失效",
  token_invalid: "授权失效",
  agent_offline: "助手离线",
  idle_3d: "3 天没发东西",
  no_content_today: "今日无内容",
};

export interface PlatformSignals {
  health: FullHealth;
  supplier: SupplierBalanceResult;
  incidents: IncidentCount[];
}

/** 平台级(跨租户)信号 → 简报条目 */
export function judgePlatform(s: PlatformSignals): BriefItem[] {
  const items: BriefItem[] = [];

  if (s.health.status === "error") {
    const broken = Object.entries(s.health.checks).filter(([, c]) => c.status === "error").map(([k]) => k).join("/");
    items.push({ level: "alert", text: `系统组件不可用: ${broken} —— 服务大概率已经不能干活了, 需立刻找技术。` });
  } else if (s.health.status === "degraded") {
    const warn = Object.entries(s.health.checks).filter(([, c]) => c.status === "warn").map(([k]) => k).join("/");
    items.push({ level: "warn", text: `系统亚健康: ${warn} 触发阈值(磁盘不足 2GB / 队列积压) —— 还能跑, 但该找技术看一眼了。` });
  }

  for (const r of s.supplier.reasons) {
    items.push({ level: s.supplier.level === "alert" ? "alert" : "warn", text: r });
  }

  for (const inc of s.incidents) {
    // llm_quota 已由 supplier 判定覆盖, 不重复刷屏
    if (inc.kind === "llm_quota") continue;
    const label = KIND_LABEL[inc.kind] ?? inc.kind;
    const level: BriefLevel = inc.kind === "ledger_write_failed" || inc.kind === "zero_output" ? "alert" : "warn";
    items.push({ level, text: `${label} 近 24h 发生 ${inc.count} 次 —— 最后一条: ${inc.lastMessage.slice(0, 80)}` });
  }

  return items;
}

// ============ 渲染 (纯函数) ============

/**
 * 渲染企微纯文本。异常置顶、正常折一行。企微 text 上限 2048 字节, 这里控在 ~1200 字内。
 */
export function renderBriefingText(
  date: string,
  platform: PlatformBriefing,
  tenantBriefs: TenantBriefing[],
): string {
  const all: BriefItem[] = [...platform.items, ...tenantBriefs.flatMap((t) => t.items)];
  const alerts = all.filter((i) => i.level === "alert");
  const warns = all.filter((i) => i.level === "warn");

  const L: string[] = [];
  L.push(`【BossMate 运维简报】${date}`);
  L.push("");

  if (alerts.length > 0) {
    L.push("🔴 需要立刻处理");
    for (const a of alerts.slice(0, 8)) L.push(`· ${a.text}`);
    if (alerts.length > 8) L.push(`· …另有 ${alerts.length - 8} 项, 见今日驾驶舱`);
    L.push("");
  }
  if (warns.length > 0) {
    L.push("🟡 今天内看一眼");
    for (const w of warns.slice(0, 8)) L.push(`· ${w.text}`);
    if (warns.length > 8) L.push(`· …另有 ${warns.length - 8} 项, 见今日驾驶舱`);
    L.push("");
  }
  if (alerts.length === 0 && warns.length === 0) {
    L.push("✅ 一切正常, 没有需要你动手的事。");
    L.push("");
  }

  // 正常时也要让人知道系统活着 —— 一行汇总, 不做流水账
  L.push("— 今日概况 —");
  L.push(`系统健康: ${platform.health.status === "ok" ? "正常" : platform.health.status === "degraded" ? "亚健康" : "异常"}`);
  for (const t of tenantBriefs.slice(0, 5)) {
    const budgetPart = t.spend.usedPct !== null ? ` / 预算已用 ${t.spend.usedPct}%` : "";
    L.push(
      `${t.tenantName}: 生成 ${t.generatedToday} 条 · 进草稿箱 ${t.draftPushedToday} 条 · 发布 ${t.publishedToday} 条 · ` +
      `账号 ${t.accounts.total}(异常 ${t.accounts.abnormal}) · 今日花费 ${yuan(t.spend.todayCents)} 元${budgetPart}`,
    );
  }
  if (tenantBriefs.length > 5) L.push(`…另有 ${tenantBriefs.length - 5} 个租户, 见今日驾驶舱`);
  if (platform.supplier.aliyunAvailableYuan !== null) {
    L.push(`阿里云账户余额: ${platform.supplier.aliyunAvailableYuan.toFixed(2)} 元`);
  }
  L.push("");
  L.push("详情打开「今日驾驶舱」。本简报每天自动发送一次(正常也发, 没收到=简报本身出问题了)。");

  return L.join("\n");
}

// ============ 采集 ============

/** 单租户采集 */
export async function collectTenantBriefing(
  tenantId: string,
  tenantName: string,
  now: Date = new Date(),
): Promise<TenantBriefing> {
  const since = startOfBjDay(now);
  const target = Math.max(1, Math.min(
    Math.floor(env.DRAFT_PUSH_PER_ACCOUNT),
    Math.floor(env.DRAFT_TARGET_PER_ACCOUNT),
  ));

  const [
    [genRow],
    tasks,
    draftRows,
    [pubRow],
    wechatAccounts,
    spend,
    [tenantRow],
  ] = await Promise.all([
    // 今日生成数 — 同今日驾驶舱口径(自己租户 + SYSTEM 共享推荐池)
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contents)
      .where(and(
        inArray(contents.tenantId, [tenantId, SYSTEM_RECOMMENDATION_TENANT_ID]),
        gte(contents.createdAt, since),
      )),
    db
      .select({ status: agentPublishTasks.status, createdAt: agentPublishTasks.createdAt })
      .from(agentPublishTasks)
      .where(and(eq(agentPublishTasks.tenantId, tenantId), gte(agentPublishTasks.createdAt, since))),
    // 今日每号进草稿箱数
    db
      .select({ accountId: contentPublishLog.accountId, count: sql<number>`count(*)::int` })
      .from(contentPublishLog)
      .where(and(
        eq(contentPublishLog.tenantId, tenantId),
        gte(contentPublishLog.createdAt, since),
        eq(contentPublishLog.status, "draft_pushed"),
      ))
      .groupBy(contentPublishLog.accountId),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentPublishLog)
      .where(and(
        eq(contentPublishLog.tenantId, tenantId),
        gte(contentPublishLog.createdAt, since),
        inArray(contentPublishLog.status, ["success", "published_by_operator"]),
      )),
    db
      .select({ id: platformAccounts.id, accountName: platformAccounts.accountName })
      .from(platformAccounts)
      .where(and(
        eq(platformAccounts.tenantId, tenantId),
        eq(platformAccounts.platform, "wechat"),
        eq(platformAccounts.status, "active"),
      )),
    getSpend(tenantId),
    db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  ]);

  const pushedByAccount = new Map(draftRows.map((r) => [r.accountId, Number(r.count ?? 0)]));
  const draftShortfalls = wechatAccounts
    .map((a) => ({ accountName: a.accountName ?? "(未命名)", pushed: pushedByAccount.get(a.id) ?? 0, target }))
    .filter((x) => x.pushed < x.target);
  const draftPushedToday = [...pushedByAccount.values()].reduce((n, x) => n + x, 0);

  // AI 客服 + 账号矩阵 —— 单点失败不该拖垮整份简报
  const kf = await getKfStats(tenantId, 1, 1).then(
    (r) => ({ handoffs: r.today.handoffs, blockedSensitive: r.today.blockedSensitive, customerMessages: r.today.customerMessages }),
    (err) => {
      logger.warn({ err: err instanceof Error ? err.message : err, tenantId }, "简报: kf 统计失败, 该项留 0");
      return { handoffs: 0, blockedSensitive: 0, customerMessages: 0 };
    },
  );
  const matrix = await getMatrixOverview(tenantId).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : err, tenantId }, "简报: 账号矩阵失败, 该项留空");
    return null;
  });
  const byHealth: Record<string, number> = {};
  for (const a of matrix?.accounts ?? []) byHealth[a.health] = (byHealth[a.health] ?? 0) + 1;

  const budget: BudgetConfig = ((tenantRow?.config as { budgetConfig?: BudgetConfig } | null)?.budgetConfig) ?? {};
  const publishHealth = computePublishHealth(tasks, now);

  const signals: TenantSignals = {
    generatedToday: Number(genRow?.count ?? 0),
    draftPushedToday,
    publishedToday: Number(pubRow?.count ?? 0),
    draftShortfalls,
    draftTargetPerAccount: target,
    publishHealth,
    kf,
    spend: { todayCents: spend.todayCents, monthCents: spend.monthCents, budget },
    accounts: {
      total: matrix?.summary.totalAccounts ?? 0,
      abnormal: matrix?.summary.abnormalAccounts ?? 0,
      byHealth,
    },
    minDailyContent: env.OPS_MIN_DAILY_CONTENT,
    budgetWarnPct: env.OPS_BUDGET_WARN_PCT,
    handoffWarnCount: env.OPS_HANDOFF_WARN_COUNT,
  };
  const { items, usedPct } = judgeTenant(signals);

  return {
    tenantId,
    tenantName,
    generatedToday: signals.generatedToday,
    draftPushedToday,
    publishedToday: signals.publishedToday,
    draftShortfalls,
    draftTargetPerAccount: target,
    publishHealth,
    kf,
    spend: { todayCents: spend.todayCents, monthCents: spend.monthCents, budget, usedPct },
    accounts: signals.accounts,
    items,
    level: worstLevel(items),
  };
}

/** 平台级采集(跨租户: 系统健康 + 供应商余额 + 异常事件流水) */
export async function collectPlatformBriefing(now: Date = new Date()): Promise<PlatformBriefing> {
  const since = startOfBjDay(now);
  const [health, supplier, incidents] = await Promise.all([
    runFullHealthCheck().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err }, "简报: 健康体检失败");
      return { status: "error" as const, timestamp: new Date().toISOString(), checks: {} };
    }),
    checkSupplierBalance(since).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err }, "简报: 供应商余额检查失败");
      return {
        aliyunAvailableYuan: null, aliyunCurrency: null, aliyunError: "检查异常",
        avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0,
        level: "ok" as const, reasons: [] as string[],
      };
    }),
    getIncidentSummary(24),
  ]);
  const items = judgePlatform({ health, supplier, incidents });
  return { health, supplier, incidents, items, level: worstLevel(items) };
}

// ============ 主流程 ============

/**
 * 跑一次每日简报: 采集 → 判定 → 渲染 → 企微推送(失败降级) → 落库。
 * 由 scheduler(每日 09:30 BJ) 或 POST /today/ops-briefing/run 手动触发。
 */
export async function runDailyBriefing(): Promise<BriefingResult> {
  const now = new Date();
  const date = bjDateString(now);

  const activeTenants = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  const platform = await collectPlatformBriefing(now);

  const tenantBriefs: TenantBriefing[] = [];
  for (const t of activeTenants) {
    try {
      tenantBriefs.push(await collectTenantBriefing(t.id, t.name, now));
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, tenantId: t.id }, "简报: 单租户采集失败(跳过, 不影响其他租户)");
    }
  }

  const level = worstLevel([...platform.items, ...tenantBriefs.flatMap((x) => x.items)]);
  const text = renderBriefingText(date, platform, tenantBriefs);

  // ① 推送(复用企微 notifyStaff)。返回 false = 未配置或发送失败, 一律走降级。
  let pushed = false;
  let pushError: string | null = null;
  if (env.OPS_BRIEFING_PUSH_ENABLED) {
    try {
      pushed = await notifyStaff(truncateForWecom(text));
      if (!pushed) pushError = "企微推送未成功(多为未配置自建应用 Secret / 通知人, 或企微接口报错, 详见服务器日志)";
    } catch (err) {
      pushError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    }
  } else {
    pushError = "企微推送已关闭(OPS_BRIEFING_PUSH_ENABLED=false)";
  }

  // ② 落库 —— 推送成功与否都落, 这是"告警本身挂了也看得到"的兜底
  for (const tb of tenantBriefs) {
    const ownText = renderBriefingText(date, platform, [tb]);
    try {
      await db.insert(opsBriefings).values({
        tenantId: tb.tenantId,
        briefDate: date,
        level: worstLevel([...platform.items, ...tb.items]),
        summary: { platform: { level: platform.level, items: platform.items, health: platform.health.status, supplier: platform.supplier }, tenant: tb } as unknown as Record<string, unknown>,
        text: ownText,
        pushed,
        pushError: pushError?.slice(0, 300) ?? null,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, tenantId: tb.tenantId }, "简报落库失败");
    }
  }

  // ③ 推送失败本身也是一条要被看见的异常
  if (!pushed) {
    await recordIncident({
      kind: "briefing_push_failed",
      severity: level === "alert" ? "error" : "warn",
      message: `每日简报未推送成功: ${pushError ?? "未知原因"}`,
      detail: { date, level },
    });
    logger.error({ date, level, pushError }, "⚠️ 每日运维简报未推送成功 —— 已落库, 请到今日驾驶舱查看");
  }

  logger.info({ date, level, tenants: tenantBriefs.length, pushed }, "每日运维简报完成");
  return { date, level, text, pushed, pushError, tenantsProcessed: tenantBriefs.length };
}

/** 取某租户最近一次简报(今日驾驶舱卡片用) */
export async function getLatestBriefing(tenantId: string): Promise<{
  date: string; level: BriefLevel; text: string; pushed: boolean; pushError: string | null;
  summary: unknown; createdAt: Date | string;
} | null> {
  const [row] = await db
    .select()
    .from(opsBriefings)
    .where(eq(opsBriefings.tenantId, tenantId))
    .orderBy(sql`${opsBriefings.createdAt} DESC`)
    .limit(1);
  if (!row) return null;
  return {
    date: String(row.briefDate),
    level: row.level as BriefLevel,
    text: row.text,
    pushed: row.pushed,
    pushError: row.pushError,
    summary: row.summary,
    createdAt: row.createdAt,
  };
}
