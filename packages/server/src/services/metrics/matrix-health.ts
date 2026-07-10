/**
 * 7-10 矩阵总览 — 账号健康判定纯函数（无 IO，单测友好）。
 *
 * 数据采集/聚合在 matrix-overview.ts；本文件只做"给定信号 → 健康枚举"的判定，
 * 以及北京时间日边界工具（与 routes/today.ts 同口径：服务器跑 UTC，按 BJ 零点切"今天"）。
 *
 * 健康枚举与数据来源：
 *   login_expired    — agent_publish_tasks 近 24h 出现 login_expired，或 platform_accounts.loginStatus='expired'
 *   token_invalid    — platform_accounts.status='expired'（API 平台 verify 失败会置此值，见 accounts.ts /verify）
 *   agent_offline    — 账号绑定了 agent 设备(agentDeviceId)且设备离线（lastSeenAt > 90s，同 accounts.ts 口径）
 *   idle_3d          — 连续 3 天（前天/昨天/今天）无成功发布（success | published_by_operator）
 *   no_content_today — 今天没分到任何内容（publish log + agent 任务今日均为 0）
 *   disabled         — 账号已停用（不计入异常，仅置灰展示）
 */

export type AccountHealth =
  | "healthy"
  | "login_expired"
  | "token_invalid"
  | "agent_offline"
  | "idle_3d"
  | "no_content_today"
  | "disabled";

/** 主状态取 flags 中最严重者；数字越小越严重（前端按此排序，异常置顶） */
export const HEALTH_SEVERITY: Record<AccountHealth, number> = {
  login_expired: 0,
  token_invalid: 1,
  agent_offline: 2,
  idle_3d: 3,
  no_content_today: 4,
  healthy: 5,
  disabled: 6,
};

export function healthRank(h: AccountHealth): number {
  return HEALTH_SEVERITY[h] ?? 99;
}

/** 与 routes/today.ts 相同的北京时间偏移 */
export const BJ_OFFSET_MS = 8 * 3600_000;

/** 北京时间"今天 00:00"对应的 UTC 时刻 */
export function startOfBjDay(now: Date = new Date()): Date {
  const bj = new Date(now.getTime() + BJ_OFFSET_MS);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - BJ_OFFSET_MS);
}

/**
 * idle_3d 窗口起点 = 前天 00:00（北京时间）。
 * "连续 3 天无成功发布" = 自前天零点起（覆盖前天/昨天/今天三个自然日）没有任何成功发布。
 */
export function idleWindowStart(startOfToday: Date): Date {
  return new Date(startOfToday.getTime() - 2 * 86_400_000);
}

export interface HealthInput {
  /** platform_accounts.status: active | disabled | expired */
  accountStatus: string;
  /** platform_accounts.loginStatus: none | logged_in | expired（半自动平台浏览器登录态） */
  loginStatus?: string | null;
  /** 是否绑定了 agent 设备 */
  agentDeviceBound: boolean;
  /** 绑定设备是否在线（lastSeenAt < 90s；未绑定时忽略） */
  agentOnline: boolean;
  /** 近 24h agent 任务是否出现过 login_expired */
  loginExpired24h: boolean;
  /** 最近一次成功发布时间（content_publish_log status in success/published_by_operator 的 max(updated_at)），无则 null */
  lastSuccessAt: Date | null;
  /** 今日分到的内容数（今日 publish log 行数 + 今日 agent 任务数；仅用于 >0 判定，重叠计数无碍） */
  assignedToday: number;
  /** 账号创建时间（新账号宽限：创建不满 3 天不判 idle_3d） */
  createdAt: Date;
}

export interface HealthResult {
  /** 最严重的一项作为主状态 */
  health: AccountHealth;
  /** 命中的全部告警（healthy/disabled 时为空数组） */
  flags: AccountHealth[];
}

export function computeAccountHealth(
  input: HealthInput,
  startOfToday: Date,
): HealthResult {
  if (input.accountStatus === "disabled") {
    return { health: "disabled", flags: [] };
  }

  const flags: AccountHealth[] = [];

  // 1. 登录态失效：agent 任务近 24h login_expired，或服务器侧浏览器登录态标 expired
  if (input.loginExpired24h || input.loginStatus === "expired") {
    flags.push("login_expired");
  }

  // 2. 凭证失效痕迹：verify 失败会把账号 status 置为 expired（API 平台，如公众号）
  if (input.accountStatus === "expired") {
    flags.push("token_invalid");
  }

  // 3. Agent 设备离线：仅对绑定了设备的账号有意义
  if (input.agentDeviceBound && !input.agentOnline) {
    flags.push("agent_offline");
  }

  // 4. 连续 3 天无成功发布（新账号宽限：创建时间落在窗口内不判）
  const idleSince = idleWindowStart(startOfToday);
  const idle = input.lastSuccessAt
    ? input.lastSuccessAt.getTime() < idleSince.getTime()
    : input.createdAt.getTime() < idleSince.getTime();
  if (idle) {
    flags.push("idle_3d");
  }

  // 5. 今天没分到内容
  if (input.assignedToday <= 0) {
    flags.push("no_content_today");
  }

  if (flags.length === 0) {
    return { health: "healthy", flags: [] };
  }
  const sorted = [...flags].sort((a, b) => healthRank(a) - healthRank(b));
  return { health: sorted[0], flags: sorted };
}
