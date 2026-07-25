/**
 * 7-25 运维告警③: 健康体检数据层 (原 routes/health.ts 内联实现抽出)
 *
 * 抽出原因(红线 #11 复用>重写): 每日简报也要报 degraded(磁盘满/队列积压), 不能把
 * routes/health.ts 里的判定逻辑再抄一份 —— 抄一份就一定会漂。routes/health.ts 现在
 * 只剩路由壳, 判定与阈值全在这里, 简报与 /health/full 永远同口径。
 *
 * 阈值: 磁盘可用 <2GB 或 队列 failed>50 或 waiting>200 → warn; DB/Redis 不通 → error。
 */
import { statfs } from "node:fs/promises";
import { testConnection } from "../../models/db.js";
import { env } from "../../config/env.js";

export const DISK_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
export const QUEUE_FAILED_WARN = 50;
export const QUEUE_WAITING_WARN = 200;

export type CheckStatus = "ok" | "warn" | "error";
export type CheckResult = { status: CheckStatus; [k: string]: unknown };

export async function checkDb(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const ok = await testConnection();
    return { status: ok ? "ok" : "error", latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

export async function checkRedis(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const { getRedisConnection } = await import("../task/queue.js");
    const pong = await Promise.race([
      getRedisConnection().ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ping 超时(3s)")), 3000)),
    ]);
    return { status: pong === "PONG" ? "ok" : "error", latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

export async function checkQueues(): Promise<CheckResult> {
  try {
    const { contentQueue, videoQueue, crawlerQueue } = await import("../task/queue.js");
    const queues = { content: contentQueue, video: videoQueue, crawler: crawlerQueue };
    const detail: Record<string, Record<string, number>> = {};
    let worst: "ok" | "warn" = "ok";
    for (const [name, q] of Object.entries(queues)) {
      const c = await q.getJobCounts("waiting", "active", "failed", "delayed");
      detail[name] = c as Record<string, number>;
      if ((c.failed ?? 0) > QUEUE_FAILED_WARN || (c.waiting ?? 0) > QUEUE_WAITING_WARN) worst = "warn";
    }
    return { status: worst, queues: detail };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

export async function checkDisk(): Promise<CheckResult> {
  try {
    const s = await statfs(env.UPLOAD_DIR).catch(() => statfs("."));
    const freeBytes = s.bavail * s.bsize;
    const totalBytes = s.blocks * s.bsize;
    return {
      status: freeBytes < DISK_MIN_FREE_BYTES ? "warn" : "ok",
      freeGB: +(freeBytes / 1024 ** 3).toFixed(2),
      totalGB: +(totalBytes / 1024 ** 3).toFixed(2),
      usedPct: +((1 - freeBytes / totalBytes) * 100).toFixed(1),
    };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

export function checkMemory(): CheckResult {
  const m = process.memoryUsage();
  return {
    status: "ok",
    rssMB: Math.round(m.rss / 1024 / 1024),
    heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  };
}

export interface FullHealth {
  status: "ok" | "degraded" | "error";
  timestamp: string;
  checks: Record<string, CheckResult>;
}

/** 全组件体检 — /health/full 与每日简报共用 */
export async function runFullHealthCheck(): Promise<FullHealth> {
  const [db, redis, queues, disk] = await Promise.all([checkDb(), checkRedis(), checkQueues(), checkDisk()]);
  const memory = checkMemory();
  const checks: Record<string, CheckResult> = { db, redis, queues, disk, memory };

  let status: "ok" | "degraded" | "error" = "ok";
  if (Object.values(checks).some((c) => c.status === "error")) status = "error";
  else if (Object.values(checks).some((c) => c.status === "warn")) status = "degraded";

  return { status, timestamp: new Date().toISOString(), checks };
}

/**
 * 极简存活探针 — 只回"活/不活", 不吐任何内部细节。
 * 外部拨测(UptimeRobot 等)是**不鉴权**的公网入口, 队列积压数/磁盘容量/DB 延迟
 * 都属内部情报, 一律不外露; 要看细节走 /health/full。
 */
export async function runLivenessProbe(): Promise<{ alive: boolean }> {
  const [dbRes, redisRes] = await Promise.all([checkDb(), checkRedis()]);
  return { alive: dbRes.status === "ok" && redisRes.status === "ok" };
}
