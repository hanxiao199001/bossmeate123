/**
 * 5-23 PR #161 — bulk-distribute BullMQ queue.
 *
 * 笛卡尔积 (contentId × accountId) 每对一个 job, throttle 通过 BullMQ delay 实现.
 * 完成后 worker INSERT content_publish_log (ON CONFLICT UPDATE).
 */
import { Queue, QueueEvents } from "bullmq";
import { getRedisConnection } from "../task/queue.js";

export const bulkDistributeQueue = new Queue("bulk-distribute", {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 1, // 不自动重试 (失败入 log 等手动重发)
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export const bulkDistributeQueueEvents = new QueueEvents("bulk-distribute", {
  connection: getRedisConnection(),
});

/** 并发上限 — 多 platform 同时发但单 batch 串行避免 API rate limit */
export const BULK_DISTRIBUTE_CONCURRENCY = 3;

/** ProgressTracker — in-memory 短生命周期 (server restart 后 frontend 重连无 progress) */
export interface BulkProgress {
  batchId: string;
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  startedAt: number;
  finishedAt?: number;
  lastFailed?: { contentId: string; accountId: string; error: string };
  /** SSE 订阅回调列表 */
  subscribers: Set<(p: BulkProgress) => void>;
}

const progressMap = new Map<string, BulkProgress>();

export function initBulkProgress(batchId: string, total: number, skipped: number): BulkProgress {
  const p: BulkProgress = {
    batchId,
    total,
    completed: skipped, // skipped 算 completed (跳过的也是处理完了)
    success: 0,
    failed: 0,
    skipped,
    startedAt: Date.now(),
    subscribers: new Set(),
  };
  progressMap.set(batchId, p);
  return p;
}

export function getBulkProgress(batchId: string): BulkProgress | undefined {
  return progressMap.get(batchId);
}

export function updateBulkProgress(
  batchId: string,
  delta: { success?: boolean; failed?: boolean; skipped?: boolean; lastFailed?: BulkProgress["lastFailed"] }
): void {
  const p = progressMap.get(batchId);
  if (!p) return;
  if (delta.success) { p.success++; p.completed++; }
  if (delta.failed) { p.failed++; p.completed++; }
  if (delta.skipped) { p.skipped++; p.completed++; }
  if (delta.lastFailed) p.lastFailed = delta.lastFailed;
  if (p.completed >= p.total && !p.finishedAt) p.finishedAt = Date.now();
  // 通知 SSE subscribers
  for (const cb of p.subscribers) {
    try { cb(p); } catch { /* ignore */ }
  }
  // 完成后 10 分钟清理 (允许 frontend 拉最终结果)
  if (p.finishedAt) {
    setTimeout(() => progressMap.delete(batchId), 600_000);
  }
}
