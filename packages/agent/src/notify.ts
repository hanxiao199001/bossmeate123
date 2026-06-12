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
function psEscape(v: string): string {
  return v.replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

/** 弹系统通知 (fire-and-forget, 任何失败只记日志)。macOS=osascript, Windows=PowerShell 气泡。 */
export function notify(title: string, body: string, opts?: { sound?: boolean }): void {
  const os = platform();
  if (os === "darwin") {
    const sound = opts?.sound === false ? "" : ' sound name "Glass"';
    const script = `display notification "${appleScriptEscape(body)}" with title "${appleScriptEscape(title)}"${sound}`;
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
      if (err) logger.warn("桌面通知发送失败:", err.message);
    });
    return;
  }
  if (os === "win32") {
    // PR-Z2: PowerShell 气泡通知 (零依赖, Win10/11 通用)
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$n = New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon = [System.Drawing.SystemIcons]::Information;",
      "$n.Visible = $true;",
      `$n.ShowBalloonTip(10000, "${psEscape(title)}", "${psEscape(body)}", [System.Windows.Forms.ToolTipIcon]::Info);`,
      "Start-Sleep -Seconds 10; $n.Dispose();",
    ].join(" ");
    exec(`powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Drawing; ${ps.replace(/"/g, '\\"')}"`, (err) => {
      if (err) logger.warn("桌面通知发送失败:", err.message);
    });
    return;
  }
  logger.warn(`[通知降级] ${title}: ${body} (当前系统暂不支持桌面通知)`);
}
