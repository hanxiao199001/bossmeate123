/**
 * journal-enrich BullMQ Worker（B.2.1.A + B.3 throttle）
 *
 * 单进程跑（concurrency=1），避免 LetPub 反爬限流。
 * routes 推任务 → worker pull → 调 enrichJournal()
 *
 * B.3 增强：每条之间 sleep delayMs ± jitterMs；连续 5 条 LetPub 没拿到数据 → abort 后续。
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./queue.js";
import { enrichJournal } from "../journal-enricher/index.js";
import { logger } from "../../config/logger.js";
import {
  LetPubFailStreakTracker,
  MAX_LETPUB_FAIL_STREAK,
  nextDelayMs,
} from "./enrich-throttle.js";

interface JournalEnrichJobData {
  journalId: string;
  /** 可选 dry-run（不 UPDATE DB），主要用于调试 */
  dryRun?: boolean;
  /** 可选跳过特定数据源 */
  skipLetpub?: boolean;
  skipDoaj?: boolean;
  /** B.3 节流：每条 enrich 完后 sleep（route 批量推任务时设置） */
  delayMs?: number;
  jitterMs?: number;
}

/** B.3 反爬护栏：单 worker 单实例计数器（concurrency=1 前提） */
const failTracker = new LetPubFailStreakTracker();
/** Exported for tests / admin reset */
export function resetLetPubFailStreak(): void {
  failTracker.reset();
}

export function startJournalEnrichWorker(): Worker {
  const worker = new Worker<JournalEnrichJobData>(
    "journal-enrich",
    async (job: Job<JournalEnrichJobData>) => {
      const { journalId, dryRun, skipLetpub, skipDoaj, delayMs, jitterMs } = job.data;
      if (!journalId) throw new Error("journal-enrich: journalId 必填");

      // B.3 abort guard：streak 已达阈值，后续任务 fast-fail，不真跑
      if (failTracker.shouldAbort()) {
        const msg = `B.3 abort: LetPub 连续 ${MAX_LETPUB_FAIL_STREAK} 条未拿到数据（疑似反爬），跳过 ${journalId}。重启 worker 重置。`;
        logger.error({ jobId: job.id, journalId, streak: failTracker.current() }, msg);
        throw new Error(msg);
      }

      logger.info({ jobId: job.id, journalId }, "journal-enrich job 开始");
      const result = await enrichJournal(journalId, { dryRun, skipLetpub, skipDoaj });

      // 反爬信号：LetPub 派生字段都没成功 → streak++；否则 reset
      failTracker.observe(result.successFields);
      logger.info(
        {
          jobId: job.id,
          journalId,
          success: result.successFields,
          failed: result.failedFields,
          letpubFailStreak: failTracker.current(),
        },
        `[B.3 progress] enrich done | streak ${failTracker.current()}/${MAX_LETPUB_FAIL_STREAK}`,
      );

      // 节流：仅 route 批量推任务时设置 delayMs；单条 enrich 默认 0
      const sleepMs = nextDelayMs(delayMs ?? 0, jitterMs ?? 0);
      if (sleepMs > 0) {
        logger.debug({ jobId: job.id, sleepMs }, "B.3 throttle sleep");
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      return result;
    },
    {
      connection: getRedisConnection(),
      // 单 worker 单并发：保护 LetPub 反爬。需要批量时由 route 注入 delayMs 加间隔。
      concurrency: 1,
    },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "journal-enrich job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "journal-enrich job failed");
  });

  logger.info("✅ journal-enrich worker 已启动 (concurrency=1, B.3 throttle ready)");
  return worker;
}
