/**
 * P0-B watchdog：检测卡死的 generating 文章并自动 → failed。
 *
 * spec：generating 状态超过 10 分钟（statusUpdatedAt < NOW() - 10min）
 * 自动 transitionToStatus(id, 'failed', {errorMessage: 'Generation timeout (10 minutes)'})
 *
 * 设计：
 * - setInterval 每 1 分钟跑一次（spec），不依赖 BullMQ（轻量场景过度工程）
 * - 用 transitionToStatus 而非直接 UPDATE，确保走状态机（generating → failed 是合法转移）
 * - 启动时机：server boot 时 startWatchdog()；shutdown 时 stopWatchdog()
 * - 失败转移由 InvalidTransitionError race 包住（其他 worker 可能同时改了 status）
 */
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { and, eq, lt } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { transitionToStatus, InvalidTransitionError } from "./state-machine.js";

export const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
export const WATCHDOG_INTERVAL_MS = 60 * 1000; // 1 分钟
export const WATCHDOG_ERROR_MESSAGE = "Generation timeout (10 minutes)";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * 单次检测：找出所有 generating + 超时的 row，逐个 → failed。
 * 返回 {stuck, failed}：stuck=匹配条件总数，failed=真转成功数。
 *
 * @param now 测试用注入；生产用默认 new Date()
 */
export async function checkStuckGenerating(
  now: Date = new Date(),
): Promise<{ stuck: number; failed: number }> {
  const cutoff = new Date(now.getTime() - WATCHDOG_TIMEOUT_MS);
  const stuckRows = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.status, "generating"), lt(contents.statusUpdatedAt, cutoff)));

  let failedCount = 0;
  for (const row of stuckRows) {
    try {
      await transitionToStatus(row.id, "failed", {
        errorMessage: WATCHDOG_ERROR_MESSAGE,
      });
      failedCount++;
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // race：可能业务流程刚好把它转走了（→ generated / → archived）
        logger.warn(
          { id: row.id, reason: err.reason },
          "P0-B watchdog: 状态转移 race，跳过（业务流程已介入）",
        );
      } else {
        logger.error({ id: row.id, err }, "P0-B watchdog: 转移异常");
      }
    }
  }

  if (stuckRows.length > 0) {
    logger.info(
      { stuck: stuckRows.length, failed: failedCount, cutoff: cutoff.toISOString() },
      "P0-B watchdog: 一轮处理完成",
    );
  }
  return { stuck: stuckRows.length, failed: failedCount };
}

/**
 * 启动 watchdog 周期任务（server boot 时调用）。幂等：重复启动只 warn 不重启。
 */
export function startWatchdog(): void {
  if (intervalHandle !== null) {
    logger.warn("P0-B watchdog: 已启动，跳过");
    return;
  }
  intervalHandle = setInterval(() => {
    checkStuckGenerating().catch((err) =>
      logger.error({ err }, "P0-B watchdog: 顶层未捕获异常"),
    );
  }, WATCHDOG_INTERVAL_MS);
  logger.info(
    { intervalMs: WATCHDOG_INTERVAL_MS, timeoutMs: WATCHDOG_TIMEOUT_MS },
    "P0-B watchdog: 启动 ✅",
  );
}

/** 停止 watchdog（shutdown / 测试用）。 */
export function stopWatchdog(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info("P0-B watchdog: 已停止");
  }
}
