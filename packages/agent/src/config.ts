/**
 * Agent 本地配置与目录约定 — 全部落在 ~/.bossmate-agent/ 下:
 *   config.json             配对产物 (serverUrl/token/deviceId/...)
 *   profiles/<accountId>/   每账号持久浏览器 profile (登录态原生在磁盘上, 不移植 cookie)
 *   tmp/                    任务视频临时下载目录 (用完即删)
 *   screenshots/            推送失败/留证截图
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const AGENT_HOME = join(homedir(), ".bossmate-agent");
export const CONFIG_PATH = join(AGENT_HOME, "config.json");
export const PROFILES_DIR = join(AGENT_HOME, "profiles");
export const TMP_DIR = join(AGENT_HOME, "tmp");
export const SCREENSHOTS_DIR = join(AGENT_HOME, "screenshots");

export interface AgentConfig {
  /** 服务器地址 (不含 /api/v1 前缀), 如 https://bossmate.example.com */
  serverUrl: string;
  /** 配对时服务器下发的明文 token (服务端只存 sha256, 丢了只能重新配对) */
  token: string;
  deviceId: string;
  tenantId: string;
  /** 配对时登记的设备名 */
  name: string;
  pairedAt: string;
}

export async function ensureDirs(): Promise<void> {
  for (const dir of [AGENT_HOME, PROFILES_DIR, TMP_DIR, SCREENSHOTS_DIR]) {
    await mkdir(dir, { recursive: true });
  }
}

/** 账号专属 profile 目录 (扫码与推送必须同一浏览器环境 — 抖音 cookie 移植必被风控踢) */
export function profileDir(accountId: string): string {
  return join(PROFILES_DIR, accountId);
}

export async function loadConfig(): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as AgentConfig;
    if (!cfg.serverUrl || !cfg.token) return null;
    return cfg;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: AgentConfig): Promise<void> {
  await ensureDirs();
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
