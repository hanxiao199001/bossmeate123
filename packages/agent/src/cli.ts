#!/usr/bin/env node
/**
 * BossMate 本地发布 Agent CLI — 跑在客户电脑 (macOS/Windows), 流程:
 *   pair   配对服务器拿 token (一次性配对码在网页设置页生成)
 *   login  本地有头浏览器扫码登录 (每账号持久 profile, 登录态落在本机磁盘)
 *   status 服务器连通 + 各账号登录态体检
 *   run    主循环: 轮询领任务 → 下载视频 → 浏览器推草稿 → 回报
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, stat, unlink } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Browser, Page } from "rebrowser-puppeteer";
import {
  CONFIG_PATH,
  SCREENSHOTS_DIR,
  TMP_DIR,
  ensureDirs,
  loadConfig,
  profileDir,
  saveConfig,
  type AgentConfig,  clearConfig,
} from "./config.js";
import { AgentApi, ApiError, type AgentAccount, type AgentTask } from "./api.js";
import { logger } from "./log.js";
import { isLoggedIn, launchAccountBrowser, openPlatformHome, scrapeAccountProfile } from "./browser.js";
import { PLATFORM_PUSHERS } from "./pushers.js";
import { notify } from "./notify.js";
import { startControlServer, openUrl } from "./control-server.js";
import { cmdInstallService, cmdServiceStatus, cmdUninstallService } from "./service.js";

const AGENT_VERSION = "0.1.0";

/** 半自动任务留下的"还开着等人工点发布"的浏览器, 按账号记录 —
 *  同账号再来任务时复用它新开标签页, 避免同 profile 二次启动撞 SingletonLock。 */
const keptBrowsers = new Map<string, Browser>();
const PLATFORM_LABEL: Record<string, string> = { douyin: "抖音", wechat_video: "视频号" };
const CLAIM_INTERVAL_MS = 15_000;
const LOGIN_WAIT_MS = 5 * 60_000; // 扫码最长等 5 分钟

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

/** 读配置, 没配对过直接退出并给指引 */
async function requireConfig(): Promise<AgentConfig> {
  const cfg = await loadConfig();
  if (!cfg) {
    logger.error(`尚未配对 (${CONFIG_PATH} 不存在或不完整)。`);
    logger.error("请先在 BossMate 网页「设置 → 本地发布 Agent」生成配对码, 然后执行:");
    logger.error("  bossmate-agent pair <服务器地址> <配对码>");
    process.exit(1);
  }
  return cfg;
}

// ===== pair =====
async function cmdPair(args: string[]): Promise<void> {
  const [serverUrl, code, nameArg] = args;
  if (!serverUrl || !code) {
    logger.error("用法: bossmate-agent pair <服务器地址> <配对码> [设备名]");
    logger.error("示例: bossmate-agent pair https://bossmate.example.com 123456 老板的MacBook");
    process.exit(1);
  }
  const name = (nameArg ?? hostname()).slice(0, 100);
  logger.info(`正在向 ${serverUrl} 配对 (设备名: ${name})...`);
  const data = await AgentApi.pair(serverUrl, code, name, AGENT_VERSION);
  await saveConfig({
    serverUrl: serverUrl.replace(/\/+$/, ""),
    token: data.token,
    deviceId: data.deviceId,
    tenantId: data.tenantId,
    name,
    pairedAt: new Date().toISOString(),
  });
  logger.info(`配对成功! 设备ID ${data.deviceId}, 配置已写入 ${CONFIG_PATH}`);
  logger.info("下一步: bossmate-agent login (本地浏览器扫码登录平台账号)");
}

// ===== login =====
/** 单账号扫码: 开有头浏览器到平台主页, 用户手机扫码, 3s 一拍轮询登录判定 */
/** 登录成功后抓真实账号信息回填(失败忽略) */
async function reportProfile(page: Page, account: AgentAccount, api?: AgentApi): Promise<void> {
  if (!api) return;
  try {
    const prof = await scrapeAccountProfile(page, account.platform);
    if (prof.uid || prof.nickname) {
      await api.reportAccountProfile(account.id, prof);
      logger.info(`[${platformLabel(account.platform)}] 账号信息已回填: ${prof.nickname ?? ""}${prof.uid ? " (" + prof.uid + ")" : ""}`);
    }
  } catch (err) {
    logger.warn(`账号信息回填失败(忽略): ${err instanceof Error ? err.message : err}`);
  }
}

async function loginAccount(account: AgentAccount, api?: AgentApi, waitMs: number = LOGIN_WAIT_MS): Promise<boolean> {
  const label = platformLabel(account.platform);
  logger.info(`[${label}] ${account.accountName}: 正在打开浏览器, 请用该账号绑定的手机 App 扫码登录...`);
  let browser: Browser | null = null;
  try {
    browser = await launchAccountBrowser(account.id);
    const page = await openPlatformHome(browser, account.platform);
    if (await isLoggedIn(page, account.platform)) {
      logger.info(`[${label}] ${account.accountName}: 本地已是登录态, 无需重新扫码`);
      await reportProfile(page, account, api);
      return true;
    }
    logger.info(`[${label}] ${account.accountName}: 等待扫码 (最长 ${Math.round(waitMs / 60_000)} 分钟, 中途关浏览器即放弃)...`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(3_000);
      if (!browser.connected) {
        logger.warn(`[${label}] ${account.accountName}: 浏览器被关闭, 放弃本账号`);
        return false;
      }
      if (await isLoggedIn(page, account.platform)) {
        await sleep(2_000); // 等登录后跳转/cookie 落稳
        logger.info(`[${label}] ${account.accountName}: 登录成功, 登录态已落在本机 profile`);
        await reportProfile(page, account, api);
        return true;
      }
    }
    logger.warn(`[${label}] ${account.accountName}: 等待扫码超时`);
    return false;
  } finally {
    // 关浏览器 → profile 落盘
    try { await browser?.close(); } catch { /* noop */ }
  }
}

async function cmdLogin(args: string[]): Promise<void> {
  const cfg = await requireConfig();
  await ensureDirs();
  const api = new AgentApi(cfg.serverUrl, cfg.token);
  const accounts = (await api.listAccounts()).filter((a) => PLATFORM_PUSHERS[a.platform]);
  if (accounts.length === 0) {
    logger.warn("服务器上没有可本地发布的账号 (抖音/视频号), 请先在网页端添加平台账号。");
    return;
  }
  logger.info(`共 ${accounts.length} 个账号:`);
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    let hasProfile = false;
    try { hasProfile = (await stat(profileDir(a.id))).isDirectory(); } catch { /* 无档案 */ }
    console.log(`  ${i + 1}. [${platformLabel(a.platform)}] ${a.accountName}  (${a.id.slice(0, 8)}…)${hasProfile ? "  [本机已有登录档案]" : ""}`);
  }

  let selected: AgentAccount[];
  if (args.includes("--all")) {
    selected = accounts;
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("请输入要登录的账号序号 (多个用逗号分隔, 如 1,3): ")).trim();
    rl.close();
    const idxs = answer.split(/[,，\s]+/).filter(Boolean).map((s) => Number(s));
    if (idxs.some((n) => !Number.isInteger(n) || n < 1 || n > accounts.length)) {
      logger.error(`序号无效: ${answer} (应为 1~${accounts.length})`);
      process.exit(1);
    }
    selected = [...new Set(idxs)].map((n) => accounts[n - 1]);
  }

  let ok = 0;
  for (const account of selected) {
    if (await loginAccount(account, api)) ok++;
  }
  logger.info(`登录完成: 成功 ${ok}/${selected.length}。下一步: bossmate-agent run (开始领任务)`);
}

// ===== add: 登录即建号(选平台→建占位号→扫码→自动变真号) =====
async function pickPlatform(): Promise<string | null> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question("要登录哪个平台? 输入数字:  1) 抖音   2) 视频号  : ")).trim();
  rl.close();
  if (ans === "1") return "douyin";
  if (ans === "2") return "wechat_video";
  return null;
}

/** 登录一个全新账号: 不用先去网页建号, 这里选平台→服务器建占位号→打开浏览器扫码→成功后自动回填真实昵称并绑定本机。 */
async function cmdAdd(_args: string[]): Promise<void> {
  const cfg = await requireConfig();
  await ensureDirs();
  const api = new AgentApi(cfg.serverUrl, cfg.token);
  const platform = await pickPlatform();
  if (!platform) { logger.error("没选有效平台(只能输 1 或 2), 已退出。"); return; }
  logger.info(`正在创建${platformLabel(platform)}账号, 马上打开浏览器, 请用要登录的${platformLabel(platform)}手机 App 扫码...`);
  let account: AgentAccount;
  try {
    account = await api.createAccount(platform);
  } catch (err) {
    logger.error(`建号失败: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const ok = await loginAccount(account, api);
  logger.info(ok
    ? `✅ ${platformLabel(platform)}账号已登录并绑定本机, 现在可以从 BossMate 给它派内容了。`
    : "登录没完成(超时或浏览器被关). 可重新双击该启动器再扫一次。");
}

// ===== ensure-login: 启动时自动给"本机还没登录"的账号补扫码(已登录的跳过, 不打扰) =====
async function cmdEnsureLogin(_args: string[]): Promise<void> {
  const cfg = await requireConfig();
  await ensureDirs();
  const api = new AgentApi(cfg.serverUrl, cfg.token);
  let accounts;
  try {
    accounts = (await api.listAccounts()).filter((a) => PLATFORM_PUSHERS[a.platform]);
  } catch (err) {
    await exitIfRevoked(err); // 401(吊销)→ 清配置退出
    throw err;
  }
  if (accounts.length === 0) {
    logger.info("还没有账号 — 稍后程序会自动打开一个\"添加账号\"网页, 点上面的按钮(登录抖音/视频号)用手机扫码即可自己加号, 全程不用打字。");
    return;
  }
  const need: AgentAccount[] = [];
  for (const a of accounts) {
    let hasProfile = false;
    try { hasProfile = (await stat(profileDir(a.id))).isDirectory(); } catch { /* 无档案 */ }
    if (!hasProfile) need.push(a);
  }
  if (need.length === 0) { logger.info("所有账号本机均已登录, 无需扫码, 直接开始领任务。"); return; }
  logger.info(`有 ${need.length} 个账号还没在本机登录, 逐个弹出浏览器扫码(已登录的已跳过)...`);
  for (const a of need) await loginAccount(a, api);
}

// ===== status =====
async function cmdStatus(args: string[]): Promise<void> {
  const cfg = await requireConfig();
  const fast = args.includes("--fast");
  const api = new AgentApi(cfg.serverUrl, cfg.token);

  try {
    const pong = await api.ping();
    logger.info(`服务器连通正常: ${cfg.serverUrl} (服务器时间 ${pong.serverTime}, 设备 ${pong.deviceId.slice(0, 8)}…)`);
  } catch (err) {
    logger.error("服务器连不通:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const accounts = (await api.listAccounts()).filter((a) => PLATFORM_PUSHERS[a.platform]);
  if (accounts.length === 0) { logger.warn("没有可本地发布的账号"); return; }
  logger.info(`账号登录状态 (${fast ? "--fast 只看本地档案" : "逐账号开浏览器实测"}):`);
  for (const a of accounts) {
    const label = `[${platformLabel(a.platform)}] ${a.accountName}`;
    if (fast) {
      let hasProfile = false;
      try { hasProfile = (await stat(profileDir(a.id))).isDirectory(); } catch { /* 无档案 */ }
      console.log(`  ${hasProfile ? "●" : "○"} ${label} — ${hasProfile ? "本机有登录档案 (未实测)" : "未登录 (无本地档案)"}`);
      continue;
    }
    let browser: Browser | null = null;
    try {
      browser = await launchAccountBrowser(a.id);
      const page = await openPlatformHome(browser, a.platform);
      const logged = await isLoggedIn(page, a.platform);
      console.log(`  ${logged ? "●" : "✗"} ${label} — ${logged ? "登录有效" : "登录态失效, 请重新 login"}`);
    } catch (err) {
      console.log(`  ? ${label} — 检测失败: ${err instanceof Error ? err.message : err}`);
    } finally {
      try { await browser?.close(); } catch { /* noop */ }
    }
  }
}

// ===== run =====
// 6-18: 任意 401(token 失效/设备已吊销)→ 清本机配置 + 退出, 下次双击启动器自动重新配对(免手动删 ~/.bossmate-agent)。
async function exitIfRevoked(err: unknown): Promise<void> {
  if (err instanceof ApiError && err.status === 401) {
    logger.error("设备已被吊销(或 token 失效) — 已重置本机配置。请重新双击启动器即可自动重新配对(若提示配对码过期, 让对接人重发新码)。");
    await clearConfig();
    notify("BossMate: 设备已被吊销", "已重置本机配置, 重新双击启动器即可重新配对");
    process.exit(1);
  }
}

// 6-17: 空闲时主动给"本机还没登录"的抖音/视频号账号弹浏览器扫码 → 一台设备绑多账号, 网页加了号这台在线机器自动弹码, 无需重启/终端。
const PROACTIVE_LOGIN_WAIT_MS = 2 * 60_000;        // 主动弹码等扫 2 分钟(比被动自愈短, 减少挡领单)
const PROACTIVE_LOGIN_COOLDOWN_MS = 10 * 60_000;   // 弹了没扫上 → 10 分钟内不再弹同一个, 防骚扰

// 共享登录锁: 防"控制台自助加号"与"挂机自动补登"对同一账号同时弹两个登录浏览器。
const loginLocks = new Set<string>();
async function loginOnce(api: AgentApi, account: AgentAccount, cooldown?: Map<string, number>): Promise<boolean> {
  if (loginLocks.has(account.id)) return false;
  loginLocks.add(account.id);
  try {
    const ok = await loginAccount(account, api, PROACTIVE_LOGIN_WAIT_MS);
    if (!ok && cooldown) cooldown.set(account.id, Date.now() + PROACTIVE_LOGIN_COOLDOWN_MS);
    return ok;
  } finally {
    loginLocks.delete(account.id);
  }
}

async function proactiveLogin(api: AgentApi, cooldown: Map<string, number>): Promise<void> {
  const accounts = (await api.listAccounts()).filter((a) => PLATFORM_PUSHERS[a.platform]);
  const now = Date.now();
  for (const a of accounts) {
    if ((cooldown.get(a.id) ?? 0) > now) continue;           // 冷却中, 跳过
    if (loginLocks.has(a.id)) continue;                       // 正在登录(可能控制台触发的), 跳过
    let hasProfile = false;
    try { hasProfile = (await stat(profileDir(a.id))).isDirectory(); } catch { /* 无档案 */ }
    if (hasProfile) continue;                                  // 已登录, 跳过
    logger.info(`[${platformLabel(a.platform)}] ${a.accountName}: 未登录, 弹出浏览器请扫码绑定到本机...`);
    notify("BossMate: 请扫码绑定账号", `[${platformLabel(a.platform)}] ${a.accountName} 请扫描弹出的浏览器二维码, 扫完即绑定本机`);
    await loginOnce(api, a, cooldown);
    return;                                                    // 一次只处理一个, 处理完回到轮询(发布优先)
  }
}

function warnLoginExpired(task: AgentTask): void {
  const label = platformLabel(task.platform);
  notify("BossMate: 账号需要重新扫码", `[${label}] ${task.accountName} 登录已过期 — 请扫描弹出的浏览器二维码; 若没看到窗口, 双击"登录账号"即可重新扫`);
  console.error("");
  console.error("  ⚠️ ════════════════════════════════════════════════════════");
  console.error(`  ⚠️  账号 [${label}] ${task.accountName} 本机登录态已失效!`);
  console.error("  ⚠️  请扫描弹出的浏览器二维码; 若窗口已关, 双击\"登录账号\"重新扫即可(无需任何命令)。");
  console.error("  ⚠️ ════════════════════════════════════════════════════════");
  console.error("");
}

/** 6-17: 挂机时登录失效自愈 — 等客户扫页面上的二维码(浏览器已开), 扫上了上报 profile(顺带绑定本机)并返回 true。 */
async function waitForScanLogin(page: Page, browser: Browser, task: AgentTask, api: AgentApi): Promise<boolean> {
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(3_000);
    if (!browser.connected) return false; // 客户把窗口关了 → 放弃
    if (await isLoggedIn(page, task.platform)) {
      await sleep(2_000); // 等 cookie 落稳
      await reportProfile(page, { id: task.accountId, platform: task.platform, accountName: task.accountName, status: "active" } as AgentAccount, api);
      logger.info(`[${platformLabel(task.platform)}] ${task.accountName} 扫码成功, 继续发布本任务`);
      return true;
    }
  }
  return false;
}

/** 失败现场截图到 ~/.bossmate-agent/screenshots/ */
async function captureFailShot(page: Page | null, task: AgentTask): Promise<void> {
  if (!page) return;
  try {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
    const shot = join(SCREENSHOTS_DIR, `task-fail-${task.id.slice(0, 8)}-${Date.now()}.png`);
    await page.screenshot({ path: shot as any, fullPage: true });
    logger.warn({ shot }, "任务失败, 现场已截图");
  } catch (err) {
    logger.warn("失败截图未能保存:", err instanceof Error ? err.message : err);
  }
}

/** 执行单个任务: 开账号浏览器 → 验登录 → 下视频 → 推草稿 → 回报; finally 关浏览器删临时文件 */
async function runTask(api: AgentApi, task: AgentTask): Promise<void> {
  const label = platformLabel(task.platform);
  logger.info(`领到任务 ${task.id.slice(0, 8)}…: [${label}] ${task.accountName} (第 ${task.attempts} 次尝试)`);
  let browser: Browser | null = null;
  let page: Page | null = null;
  let videoPath: string | null = null;
  let keepBrowserOpen = false; // 半自动任务: 保持浏览器开着等用户点发布
  let reusedKept = false; // 复用了半自动留下的浏览器: finally 不关整个浏览器
  try {
    const kept = keptBrowsers.get(task.accountId);
    if (kept?.connected) {
      browser = kept;
      reusedKept = true;
      logger.info({ accountId: task.accountId.slice(0, 8) }, "复用上一条半自动任务的浏览器窗口 (新开标签页, 原发布页不动)");
      page = await openPlatformHome(browser, task.platform, true);
    } else {
      keptBrowsers.delete(task.accountId); // 已断开的记录清掉
      browser = await launchAccountBrowser(task.accountId);
      page = await openPlatformHome(browser!, task.platform);
    }

    if (!(await isLoggedIn(page!, task.platform))) {
      // 6-17: 客户不碰终端 — 浏览器已开、二维码就在页面上, 通知客户扫码, 扫上了本任务自动继续发布。
      notify("BossMate: 请扫码登录", `[${label}] ${task.accountName} 登录已过期 — 请扫描刚弹出的浏览器里的二维码, 扫完会自动继续发布`);
      logger.warn(`[${label}] ${task.accountName} 登录失效, 已打开扫码页, 等待扫码 (最长 ${LOGIN_WAIT_MS / 60_000} 分钟)...`);
      const relogged = await waitForScanLogin(page!, browser!, task, api);
      if (!relogged) {
        keepBrowserOpen = true;                 // 留着浏览器, 客户晚点也能扫上
        keptBrowsers.set(task.accountId, browser!);
        await api.reportResult(task.id, "login_expired", "已弹扫码页, 等待扫码超时(浏览器已留开)");
        warnLoginExpired(task);
        return;
      }
      // 扫码成功 → 继续往下走发布流程
    }

    await mkdir(TMP_DIR, { recursive: true });
    videoPath = join(TMP_DIR, `task-${task.id}.mp4`);
    logger.info("正在下载任务视频...");
    await api.downloadVideo(task.id, videoPath);
    logger.info({ videoPath }, "视频下载完成");

    const pusher = PLATFORM_PUSHERS[task.platform];
    if (!pusher) throw new Error(`平台 ${task.platform} 暂不支持本地推草稿`);
    const result = await pusher({ page: page!, videoPath, caption: task.caption ?? "", title: task.title ?? "" });

    if (result && result.manual) {
      // 半自动(抖音): 已填好停在发布页, 浏览器保持打开让用户点发布。不关浏览器。
      keepBrowserOpen = true;
      keptBrowsers.set(task.accountId, browser!);
      await api.reportResult(task.id, "manual_pending", result.message ?? "已填好, 请人工点发布");
      logger.warn(`🟡 任务 ${task.id.slice(0, 8)}… [${label}] ${task.accountName}: 已填好停在发布页 — 请在浏览器点【发布】, 完成后关闭该窗口`);
      notify("BossMate: 待你点发布", `[${label}] ${task.accountName} 内容已填好, 去浏览器窗口点【发布】(可能要过一次短信验证)`);
    } else {
      await api.reportResult(task.id, "success");
      logger.info(`任务 ${task.id.slice(0, 8)}… 完成: 草稿已推到 [${label}] ${task.accountName}, 请在平台后台确认发布`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "LOGIN_EXPIRED") {
      await api.reportResult(task.id, "login_expired", "推送过程中检测到登录态失效")
        .catch((e) => logger.error("回报 login_expired 失败:", e instanceof Error ? e.message : e));
      warnLoginExpired(task);
    } else {
      logger.error({ taskId: task.id, err: msg }, "任务执行失败");
      notify("BossMate: 任务失败", `[${label}] ${task.accountName}: ${msg.slice(0, 80)}`);
      await captureFailShot(page, task);
      await api.reportResult(task.id, "failed", msg.slice(0, 500))
        .catch((e) => logger.error("回报 failed 失败:", e instanceof Error ? e.message : e));
    }
  } finally {
    if (!keepBrowserOpen) {
      if (reusedKept) {
        // 浏览器是借来的(里面还有用户待点发布的标签页), 只关本任务开的标签
        try { await page?.close(); } catch { /* noop */ }
      } else {
        try { await browser?.close(); } catch { /* noop */ }
      }
    }
    if (videoPath) { try { await unlink(videoPath); } catch { /* noop */ } }
  }
}

async function cmdRun(): Promise<void> {
  const cfg = await requireConfig();
  await ensureDirs();
  const api = new AgentApi(cfg.serverUrl, cfg.token);
  const platforms = Object.keys(PLATFORM_PUSHERS);

  // SIGINT 优雅退出: 完成当前任务再退; 再按一次立即退
  let stopping = false;
  let busy = false;
  process.on("SIGINT", () => {
    if (stopping) {
      console.error("\n再次收到 Ctrl+C, 立即退出");
      process.exit(130);
    }
    stopping = true;
    console.error(busy
      ? "\n收到退出信号: 当前任务完成后退出 (再按一次 Ctrl+C 立即退出)"
      : "\n收到退出信号, 正在退出...");
  });

  try {
    const pong = await api.ping();
    logger.info(`Agent v${AGENT_VERSION} 已启动: 服务器 ${cfg.serverUrl} 连通正常 (设备 ${pong.deviceId.slice(0, 8)}…)`);
  } catch (err) {
    await exitIfRevoked(err); // 401(吊销)→ 清配置退出
    logger.error("服务器连不通, 请检查网络/服务器地址:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  logger.info(`开始轮询领任务 (每 ${CLAIM_INTERVAL_MS / 1000}s, 平台: ${platforms.map(platformLabel).join("/")})。Ctrl+C 退出。`);

  // 6-17: 主动补登节流 + 每账号冷却(网页新增账号后, 这台在线设备自动弹码绑定)
  let lastEnsureAt = 0;
  const ENSURE_INTERVAL_MS = 60_000;
  const loginCooldown = new Map<string, number>();

  // 6-18 客户自助加号: 起本地控制台(仅 localhost)并自动打开。点按钮 → 建号 + 弹登录扫码(后台), 客户零打字。
  const ctl = await startControlServer((platform) => {
    void (async () => {
      try {
        const account = await api.createAccount(platform);
        logger.info(`[控制台] 已创建${platformLabel(platform)}账号, 正在弹出登录页, 请扫码...`);
        await loginOnce(api, account, loginCooldown);
      } catch (e) {
        logger.warn("[控制台] 自助加号失败:", e instanceof Error ? e.message : e);
      }
    })();
  }).catch(() => null);
  if (ctl) {
    logger.info(`想自己加抖音/视频号? 浏览器打开 http://localhost:${ctl.port} (已自动打开, 也可双击"添加账号"启动器)`);
    openUrl(`http://localhost:${ctl.port}`);
  }

  while (!stopping) {
    let tasks: AgentTask[] = [];
    try {
      tasks = await api.claimTasks(platforms, 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await exitIfRevoked(err); // 401(吊销)→ 清配置退出
      logger.warn("领任务失败 (稍后重试):", msg);
    }

    if (tasks.length === 0) {
      // 空闲: 周期性给未登录账号主动弹码(一次一个, 带冷却), 实现"一台设备绑多账号"零终端
      if (Date.now() - lastEnsureAt > ENSURE_INTERVAL_MS) {
        lastEnsureAt = Date.now();
        await proactiveLogin(api, loginCooldown).catch((e) => logger.warn("自动补登检查失败:", e instanceof Error ? e.message : e));
      }
      await sleep(CLAIM_INTERVAL_MS);
      continue;
    }

    for (let i = 0; i < tasks.length; i++) {
      busy = true;
      try {
        await runTask(api, tasks[i]);
      } finally {
        busy = false;
      }
      if (stopping) break;
      // 任务间随机间隔, 模拟人工节奏 (与 server draft-push 同节奏 8~20s)
      await sleep(rand(8_000, 20_000));
    }
  }
  logger.info("Agent 已退出");
}

// ===== help =====
function printHelp(): void {
  console.log(`BossMate 本地发布 Agent v${AGENT_VERSION}

用法: bossmate-agent <命令> [参数]

命令:
  pair <服务器地址> <配对码> [设备名]   与服务器配对 (配对码在网页「设置 → 本地发布 Agent」生成; 设备名缺省取本机名)
  login [--all]                         本地浏览器扫码登录平台账号 (--all 全部账号依次扫码)
  status [--fast]                       服务器连通 + 各账号登录态体检 (--fast 只看本地档案, 不开浏览器)
  run                                   主循环: 每 15s 领任务 → 本地浏览器推草稿到视频号/抖音 → 回报
  install-service                       安装常驻服务 (macOS): 开机自启+崩溃自动拉起, 不用开终端
  uninstall-service                     卸载常驻服务
  service-status                        查看常驻服务运行状态
  help                                  显示本帮助

示例:
  bossmate-agent pair https://bossmate.example.com 123456
  bossmate-agent login
  bossmate-agent run

数据目录: ~/.bossmate-agent/ (config.json 配置 / profiles 登录档案 / tmp 临时视频 / screenshots 失败截图)`);
}

// ===== 入口 =====
async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "pair": return cmdPair(rest);
    case "login": return cmdLogin(rest);
    case "add": return cmdAdd(rest);
    case "ensure-login": return cmdEnsureLogin(rest);
    case "status": return cmdStatus(rest);
    case "run": return cmdRun();
    case "install-service": return cmdInstallService();
    case "uninstall-service": return cmdUninstallService();
    case "service-status": return cmdServiceStatus();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      logger.error(`未知命令: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof ApiError) {
    logger.error(`服务器返回错误 (${err.status}): ${err.message}`);
  } else {
    logger.error("执行失败:", err instanceof Error ? (err.stack ?? err.message) : err);
  }
  process.exit(1);
});
