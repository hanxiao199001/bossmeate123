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
import { computePublishHealth, normalizePublishMode, startOfBjDay, type PublishHealth } from "../metrics/matrix-health.js";
import { getMatrixOverview } from "../metrics/matrix-overview.js";
import { notifyStaffWithRetry } from "../work-wechat/kf-client.js";
import { runFullHealthCheck, type FullHealth } from "./health-check.js";
import { checkSupplierBalance, type SupplierBalanceResult } from "./supplier-balance.js";
import { getIncidentSummary, KIND_LABEL, recordIncident, type IncidentCount } from "./incidents.js";
// 7-30 感知①: 期刊池余量(“哪个学科的刊快用完了”) —— 与选刊器同源, 见 journals/pool-inventory.ts
import { collectPoolBriefing } from "../journals/pool-inventory.js";

// ============ 数据结构 ============

export type BriefLevel = "ok" | "warn" | "alert";

/**
 * 7-27: 条目级别多一档 "info"(知道就行) —— 与 warn(今天内看一眼)明确分开。
 * 动机: 质检降级出分(quality_check_degraded)这类事**内容照常走了**, 不需要任何人动手,
 * 混进黄色区会稀释真正要看的条目; 但完全不报又违背"分数可信度待抽检"的知情权。
 * info 不参与整体级别计算(worstLevel 视同 ok), 只在简报尾部单独一段展示。
 */
export type BriefItemLevel = BriefLevel | "info";

export interface BriefItem {
  level: BriefItemLevel;
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
  /** 7-27 待办清单(人话短句, 渲染进「📋 今日待办」段): 待上传/待扫码/待复核 */
  todos: string[];
  level: BriefLevel;
}

export interface PlatformBriefing {
  health: FullHealth;
  supplier: SupplierBalanceResult;
  incidents: IncidentCount[];
  items: BriefItem[];
  /** 7-27 平台级待办(如「K 条没评上分待复核」) */
  todos: string[];
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

const LEVEL_RANK: Record<BriefItemLevel, number> = { info: 0, ok: 0, warn: 1, alert: 2 };

/** 取一组条目里最严重的等级(info 视同 ok — "知道就行"不该把整体级别顶成异常) */
export function worstLevel(items: Array<{ level: BriefItemLevel }>): BriefLevel {
  let worst: BriefLevel = "ok";
  for (const i of items) {
    if (LEVEL_RANK[i.level] > LEVEL_RANK[worst]) worst = i.level === "alert" ? "alert" : "warn";
  }
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
  /** ⚠️ 7-27 起口径 = **仅 auto 号的任务**。manual 号(人工下载上传)的任务永远没人"领取",
   *  混进来 stuckPending 会天天报"客户端没开机"假警(7-27 简报 11 条离线噪音的任务侧翻版)。 */
  publishHealth: PublishHealth;
  kf: { handoffs: number; blockedSensitive: number; customerMessages: number };
  spend: { todayCents: number; monthCents: number; budget: BudgetConfig };
  accounts: { total: number; abnormal: number; byHealth: Record<string, number> };
  /** 7-27 人工号(publishMode=manual)数量 */
  manualAccounts: number;
  /** 7-27 人工号待下载上传的内容条数(存量) —— 这才是 manual 号"运营能行动"的信号 */
  manualPendingUpload: number;
  /** 阈值 */
  minDailyContent: number;
  budgetWarnPct: number;
  handoffWarnCount: number;
}

/**
 * 租户级信号 → 简报条目 + 待办。**只产出异常与要人动手的**, 正常项由 renderer 折成一行 ✅。
 * todos = 「今天要动手做掉的清单」: 不是故障, 是活儿(下载上传/重扫码), 单独一段免得混进告警。
 */
export function judgeTenant(s: TenantSignals): { items: BriefItem[]; todos: string[]; usedPct: number | null } {
  const items: BriefItem[] = [];
  const todos: string[] = [];

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

  // ③ 发布失败/卡住(仅 auto 号 —— manual 号的"没人领"是常态, 见 TenantSignals.publishHealth 注释)
  if (s.publishHealth.stuckPending > 0) {
    items.push({ level: "alert", text: `${s.publishHealth.stuckPending} 条自动发布任务超过 10 分钟没被领取 —— 客户电脑上的发布助手没开机或掉线, 请提醒客户启动。` });
  }
  if (s.publishHealth.loginExpired > 0) {
    items.push({ level: "alert", text: `${s.publishHealth.loginExpired} 条任务登录态失效 —— 到「账号矩阵」重新扫码登录。` });
  }
  if (s.publishHealth.failed > 0) {
    items.push({ level: "warn", text: `${s.publishHealth.failed} 条发布失败 —— 到「今日驾驶舱」看失败原因, 可重派。` });
  }

  // ③-manual 7-27: 人工号的正确信号 = 「有 N 条已生成, 等运营下载后手动上传」。
  //   这是待办不是故障 —— 进 todos 段; 只有**积压超 2 天没人动**(manual_upload_stale)才升告警(走 ⑥ 账号异常)。
  if (s.manualPendingUpload > 0) {
    todos.push(`${s.manualPendingUpload} 条内容已生成待下载上传(${s.manualAccounts} 个人工号) —— 到「矩阵总览」按号下载, 传完即清`);
  }
  // 要重新扫码的号(登录失效)也是明确的"活儿", 同时保留 ⑥ 的告警条目
  const relogin = s.accounts.byHealth.login_expired ?? 0;
  if (relogin > 0) {
    todos.push(`${relogin} 个号登录失效要重新扫码 —— 「账号矩阵」列表点「重新扫码」`);
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

  return { items, todos, usedPct };
}

export const ACCOUNT_HEALTH_LABEL: Record<string, string> = {
  login_expired: "登录失效",
  token_invalid: "授权失效",
  agent_offline: "助手离线",
  manual_upload_stale: "人工号积压 2 天没人传", // 7-27: manual 号唯一的"真的没人干活"信号
  idle_3d: "3 天没发东西",
  no_content_today: "今日无内容",
};

// ============ 7-27 无人值守: 连续异常升级 (纯函数) ============

/**
 * 连续 N 天零产出/零分发 → 升级为 🚨 强告警。
 * 单日零产出已有红色条目(偶发: 节假日改配置/上游抖一天), **连续**多天 = 系统真死了且没人管 ——
 * 无人值守下这是最需要把措辞喊到最响的情况(简报标题也会因 🚨 前缀切换成强告警版, 见 renderBriefingText)。
 *
 * @param perDay 按天统计, **必须含今天且按"今天在前"排列**, 长度 >= streakDays 才可能触发
 *               (窗口不满时宁可不喊 —— 新租户第 2 天就 🚨 是误伤)。
 */
export function judgeZeroStreak(
  perDay: Array<{ generated: number; distributed: number }>,
  streakDays: number,
): BriefItem[] {
  const n = Math.max(2, Math.floor(streakDays));
  if (perDay.length < n) return [];
  const win = perDay.slice(0, n);
  const items: BriefItem[] = [];
  if (win.every((d) => d.generated === 0)) {
    items.push({
      level: "alert",
      text: `🚨【连续 ${n} 天零产出】生成链路已停摆 ${n} 天且无人处置 —— 这不是偶发波动, 系统大概率真死了。` +
        `按顺序查: ①阿里云余额/AI 额度 ②服务器是否还活着(打开系统网页) ③服务器日志 daily-recommendation。今天必须有人处理。`,
    });
  } else if (win.every((d) => d.distributed === 0)) {
    // 生成有、分发全零 → 内容在库里堆着, 一条都没到号上(质检全毙/分发链路断)
    items.push({
      level: "alert",
      text: `🚨【连续 ${n} 天零分发】内容有生成但 ${n} 天没有一条进草稿箱/发出去 —— 多半是质检把全部内容拦下(看下方质检归因), ` +
        `或分发定时任务挂了。内容在白白生成(钱照烧), 今天必须有人处理。`,
    });
  }
  return items;
}

export interface PlatformSignals {
  health: FullHealth;
  supplier: SupplierBalanceResult;
  incidents: IncidentCount[];
}

/**
 * 质检失败到几条算红色。
 * 取 5: 每日生成量按 DAILY_GEN_HARD_CAP 通常在 20-40 篇, 5 篇没评上分 ≈ 掉了一两成产能,
 * 已经不是"偶发一次超时"了。低于 5 仍报黄色, 不静默。
 */
export const QUALITY_FAIL_ALERT_COUNT = 5;

/** 平台级(跨租户)信号 → 简报条目 + 待办 */
export function judgePlatform(s: PlatformSignals): { items: BriefItem[]; todos: string[] } {
  const items: BriefItem[] = [];
  const todos: string[] = [];

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

    // ==== 7-27 质检三态: 每条 incident = 一篇内容, 条数直接可读; 三态语义**必须**分开 ====
    //   (7-27 实况: 25 条里 20 条没评上分零进草稿箱, 简报什么都没报; 修复后要一眼看到根因。)

    // ① 超时 = 主模型没响应, 该篇**随后自动换快模型重评**, 结局看下面两行 —— 本身只是过程量
    if (inc.kind === "quality_check_timeout") {
      items.push({
        level: inc.count >= QUALITY_FAIL_ALERT_COUNT ? "warn" : "info",
        text: `今日 ${inc.count} 篇质检主模型超时(已自动换快模型重评, 最终结果看"降级出分/没评上分"两行) —— ` +
          `持续大量出现让技术查 AI_QUALITY_CHECK_TIMEOUT_MS(推理型模型 60s 常不够)与网络。`,
      });
      continue;
    }
    // ② 降级出分 = **出了分、内容照常走**(进草稿箱), 只是分数来自备用快模型 —— 知道就行, 别喊人
    //    (旧版把它渲染成"没评上分进不了草稿箱", 语义反了: 那是 ③ unavailable 的事。)
    if (inc.kind === "quality_check_degraded") {
      items.push({
        level: "info",
        text: `今日 ${inc.count} 篇的质检分来自降级快模型, 内容已照常评分放行 —— 分数可信度待抽检, 有空到「内容工坊」抽一两篇看看即可。`,
      });
      continue;
    }
    // ③ 不可用 = 主 + 备用都失败, 这篇**真的没评上分** → 转 needs_review, 进不了草稿箱 —— 要人动手
    if (inc.kind === "quality_check_unavailable") {
      items.push({
        level: inc.count >= QUALITY_FAIL_ALERT_COUNT ? "alert" : "warn",
        text: `今日 ${inc.count} 篇没评上分(主模型和备用模型都失败) → 已转人工复核, 进不了草稿箱。` +
          `内容本身没查出问题, 是评分器当时不可用 —— 到「今日驾驶舱」待审列表复核放行; 大面积出现先看 AI 额度/超时配置。`,
      });
      todos.push(`${inc.count} 条没评上分待复核 —— 「今日驾驶舱」待审列表, 复核后可放行`);
      continue;
    }
    // 出稿健康闸拦截 = 差点把废稿(占位文/截断/复读)发出去, 一次也要红
    if (inc.kind === "output_unhealthy") {
      items.push({
        level: "alert",
        text: `出稿健康闸今日拦下 ${inc.count} 篇废稿(占位文/截断/复读等), 已转人工 —— 说明生成链路有故障在产废稿。最后一条: ${inc.lastMessage.slice(0, 60)}`,
      });
      continue;
    }
    // AI 调用超时是 10 分钟节流落库的 —— count 是"波数"不是次数, 直说免得误读
    if (inc.kind === "llm_timeout") {
      items.push({
        level: "warn",
        text: `AI 调用超时近 24h 报了 ${inc.count} 波(同类 10 分钟只记 1 条, 实际次数更多) —— 钱花了内容没出来的信号, 让技术看超时配置与百炼状态。`,
      });
      continue;
    }
    // 7-27 无人值守③: LLM 日上限熔断 —— 生成已停, 必须置顶让人知道"为什么今天没产出"
    if (inc.kind === "llm_cost_cap") {
      items.push({ level: "alert", text: `🛑 ${inc.lastMessage.slice(0, 200)}` });
      continue;
    }

    // ==== 7-28 ①目标闭环: 排产/分发的"没达成"从日志升进简报 ====
    //   共同措辞原则: 说清**该找谁做什么**。这几条几乎都不是技术故障, 是"料不够了", 运营自己能处理。

    // 产出不足(≠ 零产出): 系统活着但明显不够 —— 黄色, 今天内看一眼配额与期刊池
    if (inc.kind === "low_output") {
      items.push({ level: "warn", text: `${inc.lastMessage} —— 到「内容工坊」看配额是否偏高、该学科期刊/选题是否见底。` });
      continue;
    }
    // 期刊池告急: 已经在用回头刊/不对口刊了。这是**离"没内容可发"最近的一个先行指标**, 值得单独说。
    if (inc.kind === "journal_pool_exhausted") {
      items.push({
        level: "warn",
        text: `期刊池告急: 近 24h 有 ${inc.count} 次只能选到回头刊或不对口刊 —— 最后一条: ${inc.lastMessage.slice(0, 90)}。` +
          `再不补刊, 接下来就是重复发同几本 / 内容不对口。到「期刊库」补该学科的刊, 或把该学科的日配额调低。`,
      });
      continue;
    }
    // 选不出刊/选不出题: 名额直接空转 —— 这就是"今天为什么少了几篇"的答案
    if (inc.kind === "no_journal_available" || inc.kind === "no_topic_available") {
      items.push({
        level: inc.kind === "no_topic_available" ? "warn" : "warn",
        text: `${KIND_LABEL[inc.kind]}: 近 24h ${inc.count} 次 —— ${inc.lastMessage.slice(0, 110)}`,
      });
      continue;
    }
    // 候选被配额/限流跳过: 去重机制吃掉了名额, 通常意味着配额与池子大小不匹配
    if (inc.kind === "candidate_skipped") {
      items.push({ level: "warn", text: `${inc.lastMessage.slice(0, 160)} —— 多为"配额比可用池子大", 调配额或补选题/期刊。` });
      continue;
    }
    // 单篇生成失败(节流落库, count 是波数不是次数)
    if (inc.kind === "generation_failed") {
      items.push({
        level: inc.count >= QUALITY_FAIL_ALERT_COUNT ? "alert" : "warn",
        text: `生成失败近 24h 报了 ${inc.count} 波(同类 10 分钟只记 1 条, 实际更多) —— 最后一条: ${inc.lastMessage.slice(0, 90)}。先看 AI 额度与服务器日志。`,
      });
      continue;
    }
    // 分发缺口: 已经自动补救过一轮仍没填平才会落这条 —— 所以它天然是"补救也救不回来"的信号
    if (inc.kind === "draft_shortfall") {
      items.push({
        level: inc.lastMessage.includes("今日 0 篇") ? "alert" : "warn",
        text: `${inc.lastMessage.slice(0, 200)}`,
      });
      continue;
    }
    if (inc.kind === "draft_remedy_failed") {
      items.push({ level: "alert", text: `草稿缺口自动补救本身失败(${inc.count} 次) —— 补救逻辑出错了, 需要技术看: ${inc.lastMessage.slice(0, 90)}` });
      continue;
    }
    // 7-28 ②: 质检闸没跑成 —— 与 quality_check_unavailable(没评上分)平行的第二类"检查器挂了"。
    //   措辞必须写死"不是内容违规", 否则运营会去删稿(7-27 把"没评上分"当信任事故剔除的同类误读)。
    if (inc.kind === "quality_gate_unavailable") {
      items.push({
        level: inc.count >= QUALITY_FAIL_ALERT_COUNT ? "alert" : "warn",
        text: `今日 ${inc.count} 波质检闸没跑成(红线/风格/平台规则查不了, 或一致性校验异常) → 相关内容已转人工复核。` +
          `⚠️ 这**不是内容违规**, 是我们的检查器当时不可用, 内容本身没查出任何问题 —— ` +
          `到「今日驾驶舱」待审列表复核放行即可, 别当废稿删; 反复出现让技术看知识库检索与 AI 额度。`,
      });
      todos.push(`质检闸不可用导致的待复核内容 —— 「今日驾驶舱」待审列表, 复核后可放行`);
      continue;
    }

    const label = KIND_LABEL[inc.kind] ?? inc.kind;
    const level: BriefItemLevel = inc.kind === "ledger_write_failed" || inc.kind === "zero_output" ? "alert" : "warn";
    items.push({ level, text: `${label} 近 24h 发生 ${inc.count} 次 —— 最后一条: ${inc.lastMessage.slice(0, 80)}` });
  }

  return { items, todos };
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
  const infos = all.filter((i) => i.level === "info");
  const todos = [...(platform.todos ?? []), ...tenantBriefs.flatMap((t) => t.todos ?? [])];

  // 7-27 连续异常升级: 有 🚨 条目时标题换成强告警版 —— 和"普通有红条的日子"在收到的第一眼就分开
  const escalated = alerts.some((a) => a.text.includes("🚨"));

  const L: string[] = [];
  L.push(escalated
    ? `🚨🚨【BossMate 强告警|系统已连续多天异常, 今天必须有人处理】${date}`
    : `【BossMate 运维简报】${date}`);
  L.push("");

  if (alerts.length > 0) {
    L.push("🔴 需要立刻处理");
    for (const a of alerts.slice(0, 8)) L.push(`· ${a.text}`);
    if (alerts.length > 8) L.push(`· …另有 ${alerts.length - 8} 项, 见今日驾驶舱`);
    L.push("");
  }
  if (todos.length > 0) {
    L.push("📋 今日待办(不是故障, 是今天的活)");
    for (const t of todos.slice(0, 6)) L.push(`· ${t}`);
    if (todos.length > 6) L.push(`· …另有 ${todos.length - 6} 项`);
    L.push("");
  }
  if (warns.length > 0) {
    L.push("🟡 今天内看一眼");
    for (const w of warns.slice(0, 8)) L.push(`· ${w.text}`);
    if (warns.length > 8) L.push(`· …另有 ${warns.length - 8} 项, 见今日驾驶舱`);
    L.push("");
  }
  if (infos.length > 0) {
    L.push("ℹ️ 知道就行(不用动手)");
    for (const x of infos.slice(0, 5)) L.push(`· ${x.text}`);
    L.push("");
  }
  if (alerts.length === 0 && warns.length === 0 && todos.length === 0) {
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
    // 7-27: 带上所属账号的 publishMode —— manual 号的任务不能进 stuckPending 判定
    //   (人工号没有客户端来领单, "超10分钟没被领取"对它是常态, 不是"客户端没开机")
    db
      .select({
        status: agentPublishTasks.status,
        createdAt: agentPublishTasks.createdAt,
        publishMode: platformAccounts.publishMode,
      })
      .from(agentPublishTasks)
      .leftJoin(platformAccounts, eq(agentPublishTasks.accountId, platformAccounts.id))
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
    db.select({ config: tenants.config, createdAt: tenants.createdAt }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  ]);

  // 「今日进草稿箱 N 条」是**字面展示**: 只数 draft-distribute 真推进草稿箱的(status=draft_pushed)。
  const pushedByAccount = new Map(draftRows.map((r) => [r.accountId, Number(r.count ?? 0)]));
  const draftPushedToday = [...pushedByAccount.values()].reduce((n, x) => n + x, 0);

  // 7-29 修: 缺口(未达保底)判定改用**分发器那把尺子** countTodayAccountLoad(全状态计数),
  //   不再用上面这份只数 draft_pushed 的统计。
  //   病症: 7-29 简报报"5 个公众号未达保底(各 1/2)", 而分发器同一天报 1/7 —— 实测那 4 个号
  //   各有 1 条 status=success/bulk_distribute(管理后台批量推的)被简报漏数, 它们其实 2/2 达标。
  //   危害不在数字难看: 运营会去查 4 个没问题的号, 而真正坏掉的那个(appid 40013 失效、全天 0 篇)
  //   被淹在名单里。同一个判断两处各写各的, 与 7-28 分区判据那次同源。
  //   兜底: 取不到就退回旧统计并告警, 简报绝不因此整份挂掉。
  let loadByAccount = pushedByAccount;
  try {
    const { countTodayAccountLoad } = await import("../publisher/draft-distributor.js");
    loadByAccount = await countTodayAccountLoad(tenantId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, tenantId },
      "简报: 取分发器缺口口径失败, 退回 draft_pushed 计数(缺口数可能偏大)",
    );
  }
  const draftShortfalls = wechatAccounts
    .map((a) => ({ accountName: a.accountName ?? "(未命名)", pushed: loadByAccount.get(a.id) ?? 0, target }))
    .filter((x) => x.pushed < x.target);

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
  // 7-27: 发布健康只看 auto 号的任务(manual 任务没人领是常态, 见上面查询注释)
  const publishHealth = computePublishHealth(
    tasks.filter((t) => normalizePublishMode((t as { publishMode?: string | null }).publishMode) !== "manual"),
    now,
  );
  const summaryExt = matrix?.summary as { manualAccounts?: number; pendingManualUpload?: number } | undefined;

  // 7-27 连续异常升级: 近 N 天逐日 生成/分发 数(北京时间日切)。查询失败只降级为"不升级", 不拖垮简报。
  const streakDays = Math.max(2, Math.floor(env.OPS_ZERO_STREAK_DAYS));
  let streakItems: BriefItem[] = [];
  try {
    const tenantCreatedAt = tenantRow?.createdAt ? new Date(tenantRow.createdAt as unknown as string) : null;
    const tenantAgeDays = tenantCreatedAt ? (now.getTime() - tenantCreatedAt.getTime()) / 86_400_000 : Infinity;
    if (tenantAgeDays >= streakDays) {
      const windowStart = new Date(since.getTime() - (streakDays - 1) * 86_400_000);
      const genRows = await db
        .select({
          day: sql<string>`to_char(${contents.createdAt} + interval '8 hours', 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(contents)
        .where(and(
          inArray(contents.tenantId, [tenantId, SYSTEM_RECOMMENDATION_TENANT_ID]),
          gte(contents.createdAt, windowStart),
        ))
        .groupBy(sql`1`);
      const distRows = await db
        .select({
          day: sql<string>`to_char(${contentPublishLog.createdAt} + interval '8 hours', 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(contentPublishLog)
        .where(and(
          eq(contentPublishLog.tenantId, tenantId),
          gte(contentPublishLog.createdAt, windowStart),
          inArray(contentPublishLog.status, ["draft_pushed", "success", "published_by_operator"]),
        ))
        .groupBy(sql`1`);
      const genBy = new Map(genRows.map((r) => [r.day, Number(r.count ?? 0)]));
      const distBy = new Map(distRows.map((r) => [r.day, Number(r.count ?? 0)]));
      const perDay = Array.from({ length: streakDays }, (_, i) => {
        const d = bjDateString(new Date(now.getTime() - i * 86_400_000));
        return { generated: genBy.get(d) ?? 0, distributed: distBy.get(d) ?? 0 };
      });
      streakItems = judgeZeroStreak(perDay, streakDays);
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, tenantId }, "简报: 连续异常统计失败, 本次不升级");
  }

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
    manualAccounts: summaryExt?.manualAccounts ?? 0,
    manualPendingUpload: summaryExt?.pendingManualUpload ?? 0,
    minDailyContent: env.OPS_MIN_DAILY_CONTENT,
    budgetWarnPct: env.OPS_BUDGET_WARN_PCT,
    handoffWarnCount: env.OPS_HANDOFF_WARN_COUNT,
  };
  const { items, todos, usedPct } = judgeTenant(signals);
  // 连续异常条目排最前(它是"最响"的)
  const allItems = [...streakItems, ...items];

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
    items: allItems,
    todos,
    level: worstLevel(allItems),
  };
}

/** 平台级采集(跨租户: 系统健康 + 供应商余额 + 异常事件流水) */
export async function collectPlatformBriefing(now: Date = new Date()): Promise<PlatformBriefing> {
  const since = startOfBjDay(now);
  const [health, supplier, incidents, pool] = await Promise.all([
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
    // 7-30 感知①: 期刊池余量。**追加一节, 不动上面任何判定** —— 它不是"出了什么事"(incident),
    //   而是"还剩多少料", 是离"没内容可发"最近的先行指标, 只有它能在事故发生**之前**报出来。
    //   collectPoolBriefing 自带 try/catch(绝不抛错), 所以这里不再包 .catch。
    collectPoolBriefing(SYSTEM_RECOMMENDATION_TENANT_ID),
  ]);
  const { items, todos } = judgePlatform({ health, supplier, incidents });
  const allItems = [...items, ...pool.items];
  return {
    health, supplier, incidents,
    items: allItems, todos: [...todos, ...pool.todos],
    level: worstLevel(allItems),
  };
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
      // 7-27: 简报一天只有一次送达机会 → 带重试(3 次, 2s/8s 退避); 客服 handoff 仍用不重试的 notifyStaff
      pushed = await notifyStaffWithRetry(truncateForWecom(text));
      if (!pushed) pushError = "企微推送未成功(已重试 3 次; 多为未配置自建应用 Secret / 通知人, 或企微接口报错, 详见服务器日志)";
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
