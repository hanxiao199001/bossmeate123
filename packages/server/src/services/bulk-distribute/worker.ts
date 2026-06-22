/**
 * 5-23 PR #161 — bulk-distribute worker.
 *
 * 每 job = 1 个 (contentId, accountId) 对.
 * 处理: 调 publishToAccounts(skipAudit-via-forceOverride) → 写 content_publish_log + 更新 progress.
 *
 * UNIQUE INDEX 已在 endpoint 层预 SELECT 过 (skipped 提前剔除), 但保险起见
 * worker INSERT 也用 ON CONFLICT UPDATE — 防 race / 重发场景.
 */
import { Worker, Job } from "bullmq";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contentPublishLog } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { getRedisConnection } from "../task/queue.js";
import { publishToAccounts } from "../publisher/index.js";
import { updateBulkProgress, BULK_DISTRIBUTE_CONCURRENCY } from "./queue.js";

export interface BulkDistributeJob {
  batchId: string;
  contentId: string;
  accountId: string;
  tenantId: string;
  userId: string;
}

let worker: Worker<BulkDistributeJob> | null = null;

export function startBulkDistributeWorker(): Worker<BulkDistributeJob> {
  if (worker) return worker;

  worker = new Worker<BulkDistributeJob>(
    "bulk-distribute",
    async (job: Job<BulkDistributeJob>) => {
      const { batchId, contentId, accountId, tenantId, userId } = job.data;
      logger.debug({ batchId, contentId, accountId }, "PR #161 bulk-distribute job pickup");

      let status: "success" | "failed" = "failed";
      let mediaId: string | null = null;
      let errorMessage: string | null = null;

      try {
        // 6-16: 派发拆分已下沉到 publishToAccounts(抖音/视频号→本地Agent建任务; 公众号等→凭证发布),
        // worker 不再自己判平台, 统一交给它(admin 信任 system 内容, forceOverride 跳 P2 风控)。
        const results = await publishToAccounts({
          contentId,
          tenantId,
          accountIds: [accountId],
          forceOverride: true,
          overrideReason: "bulk-distribute admin-trusted",
        });
        const r = results[0];
        if (r?.success) {
          status = "success";
          mediaId = r.mediaId ?? null;
        } else {
          errorMessage = (r?.error || r?.message || "publish 失败").slice(0, 500);
        }
      } catch (err) {
        errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      }

      // INSERT log (ON CONFLICT UPDATE — 防 race / 重发) 用 raw sql 走 jsonb merge 兼容
      await db.execute(sql`
        INSERT INTO content_publish_log (tenant_id, content_id, account_id, status, media_id, error_message, initiated_by, initiated_user_id)
        VALUES (${tenantId}::uuid, ${contentId}::uuid, ${accountId}::uuid, ${status}, ${mediaId}, ${errorMessage}, 'bulk_distribute', ${userId}::uuid)
        ON CONFLICT (content_id, account_id) DO UPDATE
          SET status = EXCLUDED.status,
              media_id = EXCLUDED.media_id,
              error_message = EXCLUDED.error_message,
              updated_at = NOW()
      `);

      // 更新 progress (含每账号明细; SSE 订阅者会收到事件)
      if (status === "success") {
        updateBulkProgress(batchId, { success: true, contentId, accountId });
      } else {
        updateBulkProgress(batchId, {
          failed: true,
          contentId,
          accountId,
          error: errorMessage ?? "unknown",
          lastFailed: { contentId, accountId, error: errorMessage ?? "unknown" },
        });
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: BULK_DISTRIBUTE_CONCURRENCY,
    }
  );

  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, "PR #161 bulk-distribute job failed");
  });

  // 防 unused (contentPublishLog drizzle table 已被 raw sql 使用)
  void contentPublishLog;

  logger.info({ concurrency: BULK_DISTRIBUTE_CONCURRENCY }, "PR #161 bulk-distribute worker started");
  return worker;
}
