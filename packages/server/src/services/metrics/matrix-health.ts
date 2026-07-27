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
 *   manual_upload_stale — 【人工号专属】待下载上传的内容积压超过 2 天没人动
 *   disabled         — 账号已停用（不计入异常，仅置灰展示）
 *
 * ============ 7-27 发布模式（publishMode）— 噪音治理的根 ============
 * 背景：7-27 的运维简报报了「助手离线 11 个」，而实际运营方式是**全人工上传**
 * （系统出数字人视频 → 运营下载 → 自己在手机/浏览器传抖音、视频号），客户端根本不需要开机。
 * 这 11 条每天固定复现、永远不会被处理，还把「公众号今天全挂」这个真问题挤出了视线。
 *
 * 所以健康判据必须先看这个号**由谁按发布键**：
 *
 *   publishMode = "auto"（客户端 Agent 自动发）—— 判据不变，全套沿用。
 *
 *   publishMode = "manual"（人工下载后自己传）：
 *     ✗ agent_offline    不判。客户端不需要开，心跳断是常态不是故障。
 *                        「派了活却没人发」这个真信号由**任务侧** stuckPending 覆盖，
 *                        它只在真有活卡住时才响，比"设备心跳"精确得多。
 *     ✗ login_expired    不判。人工上传用的是**运营自己手机/浏览器上的登录态**，
 *                        跟系统里存的那份 loginState（服务端无头浏览器推草稿用的）完全无关；
 *                        而且 manual 号不再走服务端推送链路，那份登录态过期不影响任何事。
 *                        （公众号是 API 平台、走的是 token 而非扫码态，不受此条影响。）
 *     ✗ idle_3d          不判，换成 manual_upload_stale。原因：人工上传后运营**未必回系统点"已发布"**，
 *                        lastSuccessAt 长期不动是记账问题不是停摆，天天报 idle_3d 就是造第二种噪音。
 *     ✓ token_invalid    仍判（accountStatus='expired' 是显式 verify 失败，罕见但确实是硬故障）。
 *     ✓ manual_upload_stale  待上传积压最久的一条超过 2 天 → 真的没人在干活，这才值得喊。
 *     ✓ no_content_today 仍判（只在矩阵页展示，本来就不进简报）。
 */

export type PublishMode = "auto" | "manual";

/** 兜底：库里读到脏值/空值一律当 auto（保守 —— 宁可多报一条也不静默漏报） */
export function normalizePublishMode(v: string | null | undefined): PublishMode {
  return v === "manual" ? "manual" : "auto";
}

export type AccountHealth =
  | "healthy"
  | "login_expired"
  | "token_invalid"
  | "agent_offline"
  | "manual_upload_stale"
  | "idle_3d"
  | "no_content_today"
  | "disabled";

/** 主状态取 flags 中最严重者；数字越小越严重（前端按此排序，异常置顶） */
export const HEALTH_SEVERITY: Record<AccountHealth, number> = {
  login_expired: 0,
  token_invalid: 1,
  agent_offline: 2,
  manual_upload_stale: 3,
  idle_3d: 4,
  no_content_today: 5,
  healthy: 6,
  disabled: 7,
};

/**
 * 人工号"待上传积压"判定阈值。
 * 取 2 天：运营是每天下载一批的节奏，隔一天没动可能只是周末/调休，
 * 连着两天没动就不是节奏问题了。低于此不报 —— 手上有活很正常，积压才是问题。
 */
export const MANUAL_UPLOAD_STALE_MS = 2 * 86_400_000;

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

// ============ 7-25 发布健康(任务侧) — 今日驾驶舱与每日简报共用, 免两处各写一套判定 ============

/** Agent 每 15s 轮询领单; pending 超 10 分钟还没被领 = 客户端没开机/掉线, 任务石沉大海 */
export const STUCK_PENDING_MS = 10 * 60 * 1000;

export interface PublishHealth {
  stuckPending: number;
  loginExpired: number;
  failed: number;
}

/**
 * 从"今日 agent 发布任务"算发布健康。纯函数(无 IO), 判定口径的唯一出处。
 * 原实现内联在 routes/today.ts, 7-25 加每日简报时抽出复用(红线 #11)。
 */
export function computePublishHealth(
  tasks: Array<{ status: string; createdAt: Date | string }>,
  now: Date = new Date(),
): PublishHealth {
  const nowMs = now.getTime();
  let stuckPending = 0;
  let loginExpired = 0;
  let failed = 0;
  for (const t of tasks) {
    if (t.status === "pending" && nowMs - new Date(t.createdAt).getTime() > STUCK_PENDING_MS) stuckPending++;
    if (t.status === "login_expired") loginExpired++;
    if (t.status === "failed") failed++;
  }
  return { stuckPending, loginExpired, failed };
}

export interface HealthInput {
  /** platform_accounts.status: active | disabled | expired */
  accountStatus: string;
  /** platform_accounts.loginStatus: none | logged_in | expired（半自动平台浏览器登录态） */
  loginStatus?: string | null;
  /** 7-27 发布模式：auto=客户端自动发 / manual=人工下载后自己传。缺省当 auto（向后兼容） */
  publishMode?: string | null;
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
  /** 【manual 号】待下载上传的条数（agent 任务 pending/claimed/manual_pending 存量） */
  pendingUpload?: number;
  /** 【manual 号】待上传里最早那条的创建时间（判积压用），无待上传则 null */
  oldestPendingUploadAt?: Date | null;
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
  now: Date = new Date(),
): HealthResult {
  if (input.accountStatus === "disabled") {
    return { health: "disabled", flags: [] };
  }

  const mode = normalizePublishMode(input.publishMode);
  const isManual = mode === "manual";
  const flags: AccountHealth[] = [];

  // 1. 登录态失效：agent 任务近 24h login_expired，或服务器侧浏览器登录态标 expired
  //    manual 号跳过 —— 人工在自己设备上传, 系统这份登录态不参与任何链路(见文件头说明)
  if (!isManual && (input.loginExpired24h || input.loginStatus === "expired")) {
    flags.push("login_expired");
  }

  // 2. 凭证失效痕迹：verify 失败会把账号 status 置为 expired（API 平台，如公众号）
  //    这条对两种模式都判 —— 它是显式验证失败, 不是"推测出来的"
  if (input.accountStatus === "expired") {
    flags.push("token_invalid");
  }

  // 3. Agent 设备离线：仅对"绑了设备 且 靠客户端自动发"的账号有意义。
  //    manual 号的客户端本来就不开机, 这条对它永远为真 = 每天固定噪音, 直接不判。
  if (!isManual && input.agentDeviceBound && !input.agentOnline) {
    flags.push("agent_offline");
  }

  if (isManual) {
    // 4-manual. 待上传积压：有活、且最早那条压了超过 2 天没人动 → 运营真的停手了
    const oldest = input.oldestPendingUploadAt;
    if ((input.pendingUpload ?? 0) > 0 && oldest && now.getTime() - oldest.getTime() > MANUAL_UPLOAD_STALE_MS) {
      flags.push("manual_upload_stale");
    }
  } else {
    // 4-auto. 连续 3 天无成功发布（新账号宽限：创建时间落在窗口内不判）
    const idleSince = idleWindowStart(startOfToday);
    const idle = input.lastSuccessAt
      ? input.lastSuccessAt.getTime() < idleSince.getTime()
      : input.createdAt.getTime() < idleSince.getTime();
    if (idle) {
      flags.push("idle_3d");
    }
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
