/**
 * 5-23 PR #161 — bulk-distribute BullMQ queue.
 *
 * 笛卡尔积 (contentId × accountId) 每对一个 job, throttle 通过 BullMQ delay 实现.
 * 完成后 worker INSERT content_publish_log (ON CONFLICT UPDATE).
 */
import { Queue, QueueEvents } from "bullmq";
import { getRedisConnection, lazyQueue } from "../task/queue.js";

// 7-18 架构审计 A2: 惰性化, 避免 import 即开 Redis 连接(见 task/queue.ts 说明)
export const bulkDistributeQueue = lazyQueue("bulkDistributeQueue", () => new Queue("bulk-distribute", {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 1, // 不自动重试 (失败入 log 等手动重发)
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
}));

export const bulkDistributeQueueEvents = lazyQueue("bulkDistributeQueueEvents", () => new QueueEvents("bulk-distribute", {
  connection: getRedisConnection(),
}));

/** 并发上限 — 多 platform 同时发但单 batch 串行避免 API rate limit */
export const BULK_DISTRIBUTE_CONCURRENCY = 3;

/** ProgressTracker — in-memory 短生命周期 (server restart 后 frontend 重连无 progress) */
/** 6-22: 每个 (内容×账号) 对的发布结果, 供前端逐个账号展示成功/失败/跳过 */
export interface BulkItemResult {
  contentId: string;
  accountId: string;
  accountName: string;
  platform: string;
  status: "pending" | "success" | "failed" | "skipped" | "dispatched";
  error?: string;
}

export interface BulkProgress {
  batchId: string;
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  dispatched: number; // 6-22: 已派单(抖音/视频号给本地客户端, 待真发布)
  startedAt: number;
  finishedAt?: number;
  lastFailed?: { contentId: string; accountId: string; error: string };
  /** 6-22: 每对账号的明细结果(init 时全量种入, worker 逐个更新状态) */
  items: BulkItemResult[];
  /** SSE 订阅回调列表 */
  subscribers: Set<(p: BulkProgress) => void>;
}

const progressMap = new Map<string, BulkProgress>();

export function initBulkProgress(batchId: string, total: number, skipped: number, items: BulkItemResult[] = []): BulkProgress {
  const p: BulkProgress = {
    batchId,
    total,
    completed: skipped, // skipped 算 completed (跳过的也是处理完了)
    success: 0,
    failed: 0,
    skipped,
    dispatched: 0,
    startedAt: Date.now(),
    items,
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
  delta: { success?: boolean; failed?: boolean; skipped?: boolean; dispatched?: boolean; contentId?: string; accountId?: string; error?: string; lastFailed?: BulkProgress["lastFailed"] }
): void {
  const p = progressMap.get(batchId);
  if (!p) return;
  if (delta.success) { p.success++; p.completed++; }
  if (delta.failed) { p.failed++; p.completed++; }
  if (delta.skipped) { p.skipped++; p.completed++; }
  if (delta.dispatched) { p.dispatched++; p.completed++; }
  if (delta.lastFailed) p.lastFailed = delta.lastFailed;
  // 6-22: 更新对应账号明细
  if (delta.contentId && delta.accountId) {
    const it = p.items.find((x) => x.contentId === delta.contentId && x.accountId === delta.accountId);
    if (it) {
      if (delta.success) it.status = "success";
      else if (delta.dispatched) it.status = "dispatched";
      else if (delta.failed) { it.status = "failed"; it.error = delta.error ?? delta.lastFailed?.error; }
      else if (delta.skipped) it.status = "skipped";
    }
  }
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
