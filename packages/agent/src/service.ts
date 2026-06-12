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

function requireMac(): void {
  if (platform() !== "darwin") {
    logger.error("常驻服务暂只支持 macOS (launchd)。Windows 客户机后续用 NSSM/计划任务方案。");
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
  requireMac();
  await mkdir(LOG_DIR, { recursive: true });
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
  requireMac();
  await launchctl("unload", PLIST_PATH);
  try { await rm(PLIST_PATH, { force: true }); } catch { /* noop */ }
  logger.info(`常驻服务已卸载: ${SERVICE_LABEL} (如需手动跑: bossmate-agent run)`);
}

export async function cmdServiceStatus(): Promise<void> {
  requireMac();
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
