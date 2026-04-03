/**
 * 定时发布 Worker
 *
 * 每 60 秒检查 scheduled_publishes 表中
 * status=pending 且 scheduledAt <= now 的记录，
 * 调用 publishToAccounts 执行发布。
 */

import { db } from "../../models/db.js";
import { scheduledPublishes } from "../../models/schema.js";
import { eq, and, lte, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { publishToAccounts } from "../publisher/index.js";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startPublishWorker(): void {
  if (intervalHandle) return;

  logger.info("Publish worker started (interval: 60s)");

  intervalHandle = setInterval(async () => {
    if (running) return; // 防止并发
    running = true;
    try {
      await processScheduledPublishes();
    } catch (err: any) {
      logger.error({ err: err.message }, "Publish worker error");
    } finally {
      running = false;
    }
  }, 60_000);

  // Also run once immediately
  processScheduledPublishes().catch((err) =>
    logger.error({ err: err.message }, "Publish worker initial run error")
  );
}

export function stopPublishWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info("Publish worker stopped");
  }
}

async function processScheduledPublishes(): Promise<void> {
  const now = new Date();

  // Find pending items past their scheduledAt
  const pendingItems = await db
    .select()
    .from(scheduledPublishes)
    .where(
      and(
        eq(scheduledPublishes.status, "pending"),
        lte(scheduledPublishes.scheduledAt, now)
      )
    )
    .limit(10);

  if (pendingItems.length === 0) return;

  logger.info({ count: pendingItems.length }, "Processing scheduled publishes");

  for (const item of pendingItems) {
    try {
      // Mark as processing
      await db
        .update(scheduledPublishes)
        .set({ status: "publishing" })
        .where(eq(scheduledPublishes.id, item.id));

      // Call publishToAccounts
      const results = await publishToAccounts({
        contentId: item.contentId,
        tenantId: item.tenantId,
        accountIds: [item.accountId],
      });

      const allSuccess = results.every((r) => r.success);

      // Update status
      await db
        .update(scheduledPublishes)
        .set({
          status: allSuccess ? "published" : "failed",
          publishedAt: allSuccess ? new Date() : null,
          error: allSuccess ? null : results.map((r) => r.error).filter(Boolean).join("; "),
        })
        .where(eq(scheduledPublishes.id, item.id));

      logger.info(
        { id: item.id, contentId: item.contentId, platform: item.platform, success: allSuccess },
        "Scheduled publish processed"
      );
    } catch (err: any) {
      await db
        .update(scheduledPublishes)
        .set({ status: "failed", error: err.message })
        .where(eq(scheduledPublishes.id, item.id));

      logger.error(
        { id: item.id, contentId: item.contentId, err: err.message },
        "Scheduled publish failed"
      );
    }
  }
}
