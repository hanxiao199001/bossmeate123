/**
 * 健康检查（Phase 1b 增强, 2026-06-10）
 *
 * GET /health        轻量存活探针（pm2/负载均衡用, 不查依赖）
 * GET /health/db     兼容保留: 仅查数据库
 * GET /health/full   全组件体检: DB / Redis / 三条 BullMQ 队列 / 磁盘 / 内存
 *                    → status: ok | degraded | error（degraded=能跑但有隐患, 该去看了）
 *
 * 巡检用法（CC/运维）:
 *   curl -s http://localhost:3000/api/v1/health/full | jq
 * 告警阈值: 磁盘可用 <2GB 或 队列 failed>50 或 waiting>200 → degraded; DB/Redis 不通 → error
 */
import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import { testConnection } from "../models/db.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const DISK_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const QUEUE_FAILED_WARN = 50;
const QUEUE_WAITING_WARN = 200;

type CheckResult = { status: "ok" | "warn" | "error"; [k: string]: any };

async function checkDb(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const ok = await testConnection();
    return { status: ok ? "ok" : "error", latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const { getRedisConnection } = await import("../services/task/queue.js");
    const pong = await Promise.race([
      getRedisConnection().ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ping 超时(3s)")), 3000)),
    ]);
    return { status: pong === "PONG" ? "ok" : "error", latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

async function checkQueues(): Promise<CheckResult> {
  try {
    const { contentQueue, videoQueue, crawlerQueue } = await import("../services/task/queue.js");
    const queues = { content: contentQueue, video: videoQueue, crawler: crawlerQueue };
    const detail: Record<string, any> = {};
    let worst: "ok" | "warn" = "ok";
    for (const [name, q] of Object.entries(queues)) {
      const c = await q.getJobCounts("waiting", "active", "failed", "delayed");
      detail[name] = c;
      if ((c.failed ?? 0) > QUEUE_FAILED_WARN || (c.waiting ?? 0) > QUEUE_WAITING_WARN) worst = "warn";
    }
    return { status: worst, queues: detail };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "unknown" };
  }
}

async function checkDisk(): Promise<CheckResult> {
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

function checkMemory(): CheckResult {
  const m = process.memoryUsage();
  return {
    status: "ok",
    rssMB: Math.round(m.rss / 1024 / 1024),
    heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  };
}

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      status: "ok",
      service: "BossMate API",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    };
  });

  // 兼容保留（已有监控可能在打这个）
  app.get("/db", async () => {
    const ok = await testConnection();
    return { status: ok ? "ok" : "error", database: ok ? "connected" : "disconnected" };
  });

  app.get("/full", async (_req, reply) => {
    const [db, redis, queues, disk] = await Promise.all([checkDb(), checkRedis(), checkQueues(), checkDisk()]);
    const memory = checkMemory();
    const checks = { db, redis, queues, disk, memory };

    let status: "ok" | "degraded" | "error" = "ok";
    if (Object.values(checks).some((c) => c.status === "error")) status = "error";
    else if (Object.values(checks).some((c) => c.status === "warn")) status = "degraded";

    if (status !== "ok") {
      logger.warn({ checks }, `health/full: ${status}`);
    }
    // error → HTTP 503, 方便外部拨测（uptime robot / 定时 curl）直接按状态码告警
    return reply.code(status === "error" ? 503 : 200).send({
      status,
      timestamp: new Date().toISOString(),
      checks,
    });
  });
}
