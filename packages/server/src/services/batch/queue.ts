/**
 * P4 batch queue（5-12 backend Day 1）。
 * BullMQ 队列用于 batch row 异步生成，并发 5 防 LLM rate limit 爆。
 */
import { Queue, QueueEvents } from "bullmq";
import { getRedisConnection } from "../task/queue.js";

export const batchQueue = new Queue("batch-csv", {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 1, // 重试由 batch-worker 内手动控制（指数退避 30s/2min/5min）
    removeOnComplete: 500,
    removeOnFail: 500,
  },
});

export const batchQueueEvents = new QueueEvents("batch-csv", {
  connection: getRedisConnection(),
});

/** P4 worker 并发上限（spec：防 LLM rate limit）*/
export const BATCH_WORKER_CONCURRENCY = 5;
/** P4 失败 retry 指数退避（spec：30s / 2min / 5min）*/
export const BATCH_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
export const BATCH_MAX_AUTO_RETRY = 3;
