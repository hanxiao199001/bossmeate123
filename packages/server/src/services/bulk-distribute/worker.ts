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

      let status: "success" | "failed" | "dispatched" = "failed";
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
        if (r?.success && r?.dispatched) {
          // 6-22: 抖音/视频号只是派单给本地客户端, 还没真发 → 记"已派单", 不冒充成功
          status = "dispatched";
        } else if (r?.success) {
          status = "success";
          mediaId = r.mediaId ?? null;
        } else {
          errorMessage = (r?.error || r?.message || "publish 失败").slice(0, 500);
        }
      } catch (err) {
        errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      }

      /**
       * 🔴 8-20 质量快照: 冻结"按下发布键那一刻"的达标判定。
       * 语义/为什么记在这张表/为什么三档: 见 `services/publisher/quality-verdict.ts` 文件头。
       *
       * 本路径与 draft-distributor 不同 —— 这里没有建池阶段, 内容是运营在后台点选的,
       * 所以就地查一次 metadata。**判定仍走同一个纯函数**, 不在这里另写一套。
       *
       * 查不到内容行时 verdict 留 NULL(而不是塞 'unscored'):
       * "没查到"和"查到了但没评分"是两件事, 后者是内容的属性, 前者是我们的读取出了问题。
       */
      let verdict: string | null = null;
      let sixDimTotal: string | null = null;
      let scoringVersion: string | null = null;
      try {
        const { resolveQualitySnapshot } = await import("../publisher/quality-verdict.js");
        const mrows = await db.execute(sql`SELECT metadata FROM contents WHERE id = ${contentId}::uuid`);
        const meta = ((mrows as unknown as { rows?: Array<{ metadata?: unknown }> }).rows ?? [])[0]?.metadata;
        if (meta !== undefined) {
          const snap = resolveQualitySnapshot(meta);
          verdict = snap.verdict;
          sixDimTotal = snap.sixDimTotal != null ? String(snap.sixDimTotal) : null;
          scoringVersion = snap.scoringVersion;
        }
      } catch (err) {
        // 打标失败绝不能拖垮分发本身 —— 标记是为将来的分析服务的, 分发是当下的业务。
        logger.warn({ contentId, err: err instanceof Error ? err.message : String(err) }, "bulk-distribute 质量快照读取失败, verdict 留 NULL");
      }

      // INSERT log (ON CONFLICT UPDATE — 防 race / 重发) 用 raw sql 走 jsonb merge 兼容
      await db.execute(sql`
        INSERT INTO content_publish_log (tenant_id, content_id, account_id, status, media_id, error_message, initiated_by, initiated_user_id, quality_verdict, six_dim_total, scoring_version)
        VALUES (${tenantId}::uuid, ${contentId}::uuid, ${accountId}::uuid, ${status}, ${mediaId}, ${errorMessage}, 'bulk_distribute', ${userId}::uuid, ${verdict}, ${sixDimTotal}::numeric, ${scoringVersion})
        ON CONFLICT (content_id, account_id) DO UPDATE
          SET status = EXCLUDED.status,
              media_id = EXCLUDED.media_id,
              error_message = EXCLUDED.error_message,
              -- 冲突更新也写快照: 记的是**这一次**分发时的判定, 与 status 描述同一次事件
              quality_verdict = EXCLUDED.quality_verdict,
              six_dim_total = EXCLUDED.six_dim_total,
              scoring_version = EXCLUDED.scoring_version,
              updated_at = NOW()
      `);

      /**
       * 🔴 8-20：`contents.published_at` 的**唯一写入点**。
       *
       * 只在 `success` **且账号是 `full` 能力**时写 —— 那种情况下适配器确实调了
       * `freepublish/submit`；`draft_only` 的账号只 `draft/add`（进草稿箱），
       * 两者在本表里都记 `status='success'`，**从 log 里分不出来**（同一状态两种语义）。
       *
       * 写进去的确切含义：**「运营点了批量分发，账号是 full 能力，提交发布的调用返回成功」**
       * —— 不是"读者收到了"（freepublish/submit 是异步接口，提交成功 ≠ 审核通过 ≠ 推送到达）。
       *
       * 只在首次写（`IS NULL`）：重发不覆盖，第一次提交的时刻才是这个时刻。
       */
      if (status === "success") {
        try {
          const { platformAccounts, contents } = await import("../../models/schema.js");
          const { eq, and, isNull } = await import("drizzle-orm");
          const [acct] = await db
            .select({ cap: platformAccounts.capability })
            .from(platformAccounts)
            .where(eq(platformAccounts.id, accountId))
            .limit(1);
          if (acct?.cap === "full") {
            await db
              .update(contents)
              .set({ publishedAt: new Date() })
              .where(and(eq(contents.id, contentId), isNull(contents.publishedAt)));
          }
        } catch (err) {
          // 记账失败不影响分发本身 —— 观测不许有业务影响力
          logger.warn({ contentId, accountId, err: err instanceof Error ? err.message : err }, "published_at 写入失败");
        }
      }

      // 更新 progress (含每账号明细; SSE 订阅者会收到事件)
      if (status === "success") {
        updateBulkProgress(batchId, { success: true, contentId, accountId });
      } else if (status === "dispatched") {
        updateBulkProgress(batchId, { dispatched: true, contentId, accountId });
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
