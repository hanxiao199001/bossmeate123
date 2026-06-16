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
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contentPublishLog, platformAccounts, contents, agentPublishTasks } from "../../models/schema.js";
import { buildPushCaptions } from "../publisher/draft-push.js";
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
        // 抖音/视频号: 登录态在客户本机, 服务器无凭证 → 派给本地 Agent(建任务, Agent 领单上传草稿), 不走服务器凭证发布
        const [acct] = await db
          .select({ id: platformAccounts.id, accountName: platformAccounts.accountName, platform: platformAccounts.platform })
          .from(platformAccounts)
          .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.tenantId, tenantId)))
          .limit(1);
        if (acct && (acct.platform === "douyin" || acct.platform === "wechat_video")) {
          const [content] = await db
            .select({ id: contents.id, type: contents.type, title: contents.title, body: contents.body })
            .from(contents)
            .where(eq(contents.id, contentId))
            .limit(1);
          const videoSource = content?.type === "video" ? content.body : null;
          if (!content) {
            errorMessage = "内容不存在";
          } else if (!videoSource) {
            errorMessage = "抖音/视频号需视频内容(请先生成数字人视频)";
          } else {
            const { captions, titles } = await buildPushCaptions(content.id, tenantId, [acct]);
            await db.insert(agentPublishTasks).values({
              tenantId,
              contentId: content.id,
              accountId: acct.id,
              platform: acct.platform,
              accountName: acct.accountName,
              videoSource,
              caption: captions[0] ?? content.title ?? "",
              title: (titles[0] ?? content.title ?? "").slice(0, 200),
            });
            status = "success"; // 已派给 Agent(异步上传草稿), 进度计成功
          }
        } else {
          // 公众号等凭证型平台: 服务器侧发布
          const results = await publishToAccounts({
            contentId,
            tenantId,
            accountIds: [accountId],
            forceOverride: true, // admin 信任 system 内容, 跳 P2 风控
            overrideReason: "bulk-distribute admin-trusted",
          });
          const r = results[0];
          if (r?.success) {
            status = "success";
            mediaId = r.mediaId ?? null;
          } else {
            errorMessage = (r?.error || r?.message || "publish 失败").slice(0, 500);
          }
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

      // 更新 progress (SSE 订阅者会收到事件)
      if (status === "success") {
        updateBulkProgress(batchId, { success: true });
      } else {
        updateBulkProgress(batchId, {
          failed: true,
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
