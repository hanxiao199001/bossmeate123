/**
 * journal-enrich BullMQ Worker（B.2.1.A）
 *
 * 单进程跑（concurrency=1），避免 LetPub 反爬限流。
 * routes 推任务 → worker pull → 调 enrichJournal()
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./queue.js";
import { enrichJournal } from "../journal-enricher/index.js";
import { logger } from "../../config/logger.js";

interface JournalEnrichJobData {
  journalId: string;
  /** 可选 dry-run（不 UPDATE DB），主要用于调试 */
  dryRun?: boolean;
  /** 可选跳过特定数据源 */
  skipLetpub?: boolean;
  skipDoaj?: boolean;
}

export function startJournalEnrichWorker(): Worker {
  const worker = new Worker<JournalEnrichJobData>(
    "journal-enrich",
    async (job: Job<JournalEnrichJobData>) => {
      const { journalId, dryRun, skipLetpub, skipDoaj } = job.data;
      if (!journalId) throw new Error("journal-enrich: journalId 必填");

      logger.info({ jobId: job.id, journalId }, "journal-enrich job 开始");
      const result = await enrichJournal(journalId, { dryRun, skipLetpub, skipDoaj });
      logger.info(
        { jobId: job.id, journalId, summary: result.fieldsSummary, durationMs: result.durationMs },
        "journal-enrich job 完成"
      );
      return result;
    },
    {
      connection: getRedisConnection(),
      // 单 worker 单并发：保护 LetPub 反爬。需要批量时可往 cron / batch 加间隔。
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "journal-enrich job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "journal-enrich job failed");
  });

  logger.info("✅ journal-enrich worker 已启动 (concurrency=1)");
  return worker;
}
