/**
 * 带时间戳中文前缀的 console 日志小工具。
 * 调用签名兼容 server 的 pino 风格 logger.info({obj}, "msg") — 移植 pushers 时调用点零改动。
 */
function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** pino 风格 (obj, msg) → 调整为 msg 在前对象在后, 终端可读 */
function fmt(args: unknown[]): unknown[] {
  if (args.length >= 2 && typeof args[0] === "object" && args[0] !== null && typeof args[1] === "string") {
    return [args[1], ...args.slice(2), args[0]];
  }
  return args;
}

export const logger = {
  info: (...args: unknown[]) => console.log(`[${ts()}] [信息]`, ...fmt(args)),
  warn: (...args: unknown[]) => console.warn(`[${ts()}] [警告]`, ...fmt(args)),
  error: (...args: unknown[]) => console.error(`[${ts()}] [错误]`, ...fmt(args)),
};

export const log = logger;
