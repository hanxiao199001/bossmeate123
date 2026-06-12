/**
 * 桌面系统通知 — 常驻化后用户不看终端, 需要人工介入的事件必须弹系统通知。
 * macOS 用 osascript (零依赖); 其他平台降级为日志。通知失败绝不影响主流程。
 */
import { exec } from "node:child_process";
import { platform } from "node:os";
import { logger } from "./log.js";

function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 弹系统通知 (fire-and-forget, 任何失败只记日志) */
export function notify(title: string, body: string, opts?: { sound?: boolean }): void {
  if (platform() !== "darwin") {
    logger.warn(`[通知降级] ${title}: ${body} (当前系统暂不支持桌面通知)`);
    return;
  }
  const sound = opts?.sound === false ? "" : ' sound name "Glass"';
  const script = `display notification "${appleScriptEscape(body)}" with title "${appleScriptEscape(title)}"${sound}`;
  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
    if (err) logger.warn("桌面通知发送失败:", err.message);
  });
}
