/**
 * Agent 常驻化 (macOS launchd LaunchAgent):
 *   install-service   写 plist + 加载 → 开机自启 + 崩溃自动拉起, 日志落 ~/.bossmate-agent/logs/
 *   uninstall-service 卸载 + 删 plist
 *   service-status    查看是否在跑
 * LaunchAgent 跑在用户 GUI 会话内, 可以正常弹出有头浏览器与系统通知。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { logger } from "./log.js";

const run = promisify(execFile);

const SERVICE_LABEL = "com.bossmate.agent";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const LOG_DIR = join(homedir(), ".bossmate-agent", "logs");
const LOG_PATH = join(LOG_DIR, "agent.log");

const IS_WIN = platform() === "win32";
const WIN_TASK = "BossMateAgent";
const WIN_WATCHDOG = "BossMateAgentWatchdog";

function requireSupported(): void {
  if (platform() !== "darwin" && !IS_WIN) {
    logger.error("常驻服务支持 macOS (launchd) 与 Windows (计划任务)。当前系统不支持。");
    process.exit(1);
  }
}

/** dist/cli.js 的绝对路径 (service.js 与 cli.js 同目录) */
function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPlist(): string {
  const args = [process.execPath, cliPath(), "run"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xmlEscape(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(LOG_PATH)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run("launchctl", args);
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (err: any) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err).trim() };
  }
}

export async function cmdInstallService(): Promise<void> {
  requireSupported();
  await mkdir(LOG_DIR, { recursive: true });
  if (IS_WIN) return installWindowsService();
  await mkdir(dirname(PLIST_PATH), { recursive: true });
  await launchctl("unload", PLIST_PATH); // 已装过则先卸载旧的 (失败无所谓)
  await writeFile(PLIST_PATH, buildPlist(), "utf8");
  const res = await launchctl("load", "-w", PLIST_PATH);
  if (!res.ok) {
    logger.error("launchctl load 失败:", res.out);
    process.exit(1);
  }
  logger.info(`常驻服务已安装并启动: ${SERVICE_LABEL}`);
  logger.info(`  开机自启 + 崩溃自动拉起 (15s 冷却)`);
  logger.info(`  日志: tail -f ${LOG_PATH}`);
  logger.info(`  注意: 常驻服务已在轮询领任务, 不要再手动开终端跑 run (同账号会提示浏览器已在运行)`);
}

export async function cmdUninstallService(): Promise<void> {
  requireSupported();
  if (IS_WIN) return uninstallWindowsService();
  await launchctl("unload", PLIST_PATH);
  try { await rm(PLIST_PATH, { force: true }); } catch { /* noop */ }
  logger.info(`常驻服务已卸载: ${SERVICE_LABEL} (如需手动跑: bossmate-agent run)`);
}

export async function cmdServiceStatus(): Promise<void> {
  requireSupported();
  if (IS_WIN) return windowsServiceStatus();
  const res = await launchctl("list", SERVICE_LABEL);
  if (!res.ok) {
    logger.info("常驻服务未安装或未运行 (安装: bossmate-agent install-service)");
    return;
  }
  const pid = /"PID"\s*=\s*(\d+)/.exec(res.out)?.[1];
  const exit = /"LastExitStatus"\s*=\s*(\d+)/.exec(res.out)?.[1];
  logger.info(pid
    ? `常驻服务运行中 (pid ${pid})。日志: tail -f ${LOG_PATH}`
    : `常驻服务已注册但当前没在跑 (上次退出码 ${exit ?? "?"}), launchd 会自动拉起。日志: ${LOG_PATH}`);
}


// ===== PR-Z2: Windows 常驻 (schtasks 计划任务: 登录自启 + 每5分钟看门狗拉起) =====
async function schtasks(...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run("schtasks", args);
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (err: any) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err).trim() };
  }
}

/** 看门狗脚本: agent 没在跑就拉起 (输出追加到日志文件) */
function winWatchdogScript(): string {
  const node = process.execPath;
  const cli = cliPath();
  return [
    `$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${cli.replace(/\\/g, "\\\\")}*run*' }`,
    `if (-not $running) { Start-Process -FilePath "${node}" -ArgumentList '"${cli}" run' -WindowStyle Hidden -RedirectStandardOutput "${LOG_PATH}" -RedirectStandardError "${LOG_PATH}.err" }`,
  ].join("; ");
}

async function installWindowsService(): Promise<void> {
  const psFile = join(LOG_DIR, "watchdog.ps1");
  await writeFile(psFile, winWatchdogScript(), "utf8");
  const cmd = `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${psFile}"`;
  await schtasks("/Delete", "/TN", WIN_TASK, "/F");
  await schtasks("/Delete", "/TN", WIN_WATCHDOG, "/F");
  const r1 = await schtasks("/Create", "/SC", "ONLOGON", "/TN", WIN_TASK, "/TR", cmd, "/F");
  const r2 = await schtasks("/Create", "/SC", "MINUTE", "/MO", "5", "/TN", WIN_WATCHDOG, "/TR", cmd, "/F");
  if (!r1.ok || !r2.ok) {
    logger.error("计划任务创建失败 (可能需要管理员权限):", r1.out || r2.out);
    process.exit(1);
  }
  await schtasks("/Run", "/TN", WIN_WATCHDOG); // 立即拉起一次
  logger.info(`常驻服务已安装 (Windows 计划任务): 登录自启 + 每5分钟看门狗自动拉起`);
  logger.info(`  日志: ${LOG_PATH}`);
  logger.info(`  注意: 常驻服务已在轮询领任务, 不要再手动开终端跑 run`);
}

async function uninstallWindowsService(): Promise<void> {
  await schtasks("/End", "/TN", WIN_TASK);
  await schtasks("/Delete", "/TN", WIN_TASK, "/F");
  await schtasks("/Delete", "/TN", WIN_WATCHDOG, "/F");
  logger.info("常驻服务已卸载 (Windows)。如 agent 进程仍在跑, 可在任务管理器结束 node.exe。");
}

async function windowsServiceStatus(): Promise<void> {
  const r = await schtasks("/Query", "/TN", WIN_WATCHDOG);
  if (!r.ok) {
    logger.info("常驻服务未安装 (安装: bossmate-agent install-service)");
    return;
  }
  logger.info(`常驻服务已注册 (看门狗每5分钟确保运行)。日志: ${LOG_PATH}`);
}
