/**
 * 健康检查（Phase 1b 增强 2026-06-10；7-25 抽层 + 加拨测端点）
 *
 * GET /health        轻量存活探针（pm2/负载均衡用, 不查依赖, 恒 200）
 * GET /health/ping   ★外部拨测专用★ 查 DB + Redis, 只回 {status} → 200 / 503,
 *                    **不吐任何内部细节**（无队列数/磁盘/连接串/版本）。UptimeRobot 指这个。
 * GET /health/db     兼容保留: 仅查数据库
 * GET /health/full   全组件体检: DB / Redis / 三条 BullMQ 队列 / 磁盘 / 内存
 *                    → status: ok | degraded | error（degraded=能跑但有隐患, 该去看了）
 *                    ⚠️ 会返回队列积压数/磁盘容量等内部情报, 别拿它当公网拨测地址。
 *
 * 判定逻辑与阈值统一在 services/ops/health-check.ts（每日简报也读同一份, 免两处漂）。
 *
 * 巡检用法（CC/运维）:
 *   curl -s http://localhost:3000/api/v1/health/full | jq
 *   curl -si http://localhost:3000/api/v1/health/ping   # 拨测口, 看状态码即可
 */
import type { FastifyInstance } from "fastify";
import { testConnection } from "../models/db.js";
import { logger } from "../config/logger.js";
import { runFullHealthCheck, runLivenessProbe } from "../services/ops/health-check.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      status: "ok",
      service: "BossMate API",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * 7-25 外部拨测端点。无鉴权、无内部信息、无缓存。
   * 200 = 服务活着且 DB/Redis 都通; 503 = 挂了, 拨测服务直接按状态码告警。
   */
  app.get("/ping", async (_req, reply) => {
    let alive = false;
    try {
      alive = (await runLivenessProbe()).alive;
    } catch {
      alive = false;
    }
    if (!alive) logger.warn("health/ping: 503 — DB 或 Redis 不通");
    return reply
      .code(alive ? 200 : 503)
      .header("Cache-Control", "no-store")
      .send({ status: alive ? "ok" : "error" });
  });

  // 兼容保留（已有监控可能在打这个）
  app.get("/db", async () => {
    const ok = await testConnection();
    return { status: ok ? "ok" : "error", database: ok ? "connected" : "disconnected" };
  });

  app.get("/full", async (_req, reply) => {
    const result = await runFullHealthCheck();
    if (result.status !== "ok") {
      logger.warn({ checks: result.checks }, `health/full: ${result.status}`);
    }
    // error → HTTP 503, 方便外部拨测（uptime robot / 定时 curl）直接按状态码告警
    return reply.code(result.status === "error" ? 503 : 200).send(result);
  });
}
