/**
 * P4 batch-service（5-12 backend Day 1）。
 *
 * 职责：
 *   1. createBatch(csvRows, tenantId, userId, filename) → 写 batches + batch_rows + 入队
 *   2. getBatchStatus(batchId) → stats + rows
 *   3. retryRow(rowId) → 重置 row 状态 + 重新入队
 *   4. updateRowProgress(rowId, status, articleId, error) → worker 回调
 *   5. recomputeBatchProgress(batchId) → 重算 completed/failed/status 主表
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { batches, batchRows, contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import type { CsvRow } from "./csv-parser.js";
import { batchQueue } from "./queue.js";
import { planEnqueue } from "./enqueue-planner.js";

export interface CreateBatchInput {
  tenantId: string;
  userId: string;
  filename: string;
  rows: CsvRow[];
}

/** 创建 batch + 拆 row + 入队（priority 高的先跑） */
export async function createBatch(input: CreateBatchInput): Promise<{ batchId: string; rowCount: number }> {
  // PR-Z4 套餐闸: 到期/月文章配额 (SYSTEM 租户与未配 billing 的租户不受影响)
  {
    const { checkBilling, logBillingDenied } = await import("../billing/plan.js");
    const gate = await checkBilling(input.tenantId, "generate_article");
    if (!gate.allowed) {
      logBillingDenied(input.tenantId, "generate_article", gate.reason);
      throw new Error(`BILLING_LIMIT: ${gate.reason}`);
    }
  }
  const [batch] = await db
    .insert(batches)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      filename: input.filename,
      total: input.rows.length,
      status: "running",
    })
    .returning({ id: batches.id });

  if (!batch) throw new Error("batches insert 失败");

  // 批量 INSERT batch_rows
  const rowsToInsert = input.rows.map((r) => ({
    batchId: batch.id,
    rowIndex: r.rowIndex,
    topic: r.topic,
    journalId: r.journalId,
    template: r.templateId ?? r.template, // PR-Q2: templateId(真模板id) 优先, 否则 letter
    accountId: r.accountId ?? null, // PR-X1
    priority: r.priority,
  }));
  const insertedRows = await db.insert(batchRows).values(rowsToInsert).returning({ id: batchRows.id, priority: batchRows.priority });

  // 8-02 日配额分片(见 enqueue-planner 文件头的 08-01 事故复盘):
  //   超出今日剩余配额的行不再一次性怼进队列, 而是带 delay 顺延到后面几天。
  //   小批次(日常 24 行)远低于容量 → delays 全 0, 行为与改造前完全一致。
  //   分片器自身异常时退回"全部立即入队"(fallback), 绝不因为它挂了就不排产。
  const plan = await planEnqueue(insertedRows.length);

  // 入队（priority 高的 BullMQ priority 数字小 = 高优先）
  for (let i = 0; i < insertedRows.length; i++) {
    const row = insertedRows[i]!;
    const bullPriority = 6 - (row.priority ?? 3); // 1→5 / 5→1
    const delay = plan.delays[i] ?? 0;
    await batchQueue.add(
      "batch-row",
      { batchId: batch.id, rowId: row.id, tenantId: input.tenantId, userId: input.userId },
      { priority: bullPriority, jobId: `batch-${batch.id}-${row.id}`, ...(delay > 0 ? { delay } : {}) },
    );
  }

  if (plan.deferred > 0) {
    logger.warn(
      {
        batchId: batch.id, total: insertedRows.length,
        todayCapacity: plan.todayCapacity, deferred: plan.deferred, spanDays: plan.spanDays,
        callsPerArticle: Number(plan.callsPerArticle.toFixed(1)),
      },
      "P4 batch 超出今日 LLM 配额容量 — 超出部分已顺延到后续天(不是丢弃)",
    );
  }
  logger.info({ batchId: batch.id, total: input.rows.length, tenantId: input.tenantId, deferred: plan.deferred }, "P4 batch created + 入队");
  return { batchId: batch.id, rowCount: insertedRows.length };
}

/** 查 batch 状态（stats + rows 前 N 条）*/
export async function getBatchStatus(batchId: string, tenantId: string): Promise<{
  batch: typeof batches.$inferSelect;
  rows: Array<typeof batchRows.$inferSelect>;
} | null> {
  const [batch] = await db
    .select()
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.tenantId, tenantId)))
    .limit(1);
  if (!batch) return null;

  const rows = await db
    .select()
    .from(batchRows)
    .where(eq(batchRows.batchId, batchId))
    .orderBy(asc(batchRows.rowIndex));

  return { batch, rows };
}

/** Worker 回调：更新 row 状态 + 触发主表重算 */
export async function updateRowProgress(
  rowId: string,
  // 8-02 加 "pending": 撞 LLM 日上限被顺延的行要退回待跑, 不能标 failed(见 batch-worker 顺延改造)。
  //   pending 本就是 batch_rows.status 的合法值(schema.ts: pending|generating|generated|failed)。
  status: "pending" | "generating" | "generated" | "failed",
  opts: { articleId?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  await db
    .update(batchRows)
    .set({
      status,
      ...(opts.articleId !== undefined ? { articleId: opts.articleId } : {}),
      ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage?.slice(0, 500) ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(batchRows.id, rowId));

  // 找 batchId 重算主表
  const [row] = await db
    .select({ batchId: batchRows.batchId })
    .from(batchRows)
    .where(eq(batchRows.id, rowId))
    .limit(1);
  if (row) await recomputeBatchProgress(row.batchId);
}

/** 重算 batches.completed/failed/status（每次 row 状态变化时调） */
export async function recomputeBatchProgress(batchId: string): Promise<void> {
  const counts = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      completed: sql<number>`COUNT(*) FILTER (WHERE status = 'generated')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE status = 'failed')::int`,
      pending: sql<number>`COUNT(*) FILTER (WHERE status IN ('pending', 'generating'))::int`,
    })
    .from(batchRows)
    .where(eq(batchRows.batchId, batchId));

  const c = counts[0];
  if (!c) return;

  // status: pending(初创建) → running(有 row 在跑) → completed(全 generated/failed) / 部分 failed 仍 completed
  let newStatus = "running";
  if (c.pending === 0) newStatus = c.failed === c.total ? "failed" : "completed";

  await db
    .update(batches)
    .set({ completed: c.completed, failed: c.failed, status: newStatus, updatedAt: new Date() })
    .where(eq(batches.id, batchId));
}

/** 手动 retry 失败 row（重置状态 + retryCount++ + 重新入队） */
export async function retryRow(
  rowId: string,
  tenantId: string,
): Promise<{ ok: true } | { error: string }> {
  const [row] = await db
    .select({
      id: batchRows.id,
      batchId: batchRows.batchId,
      status: batchRows.status,
      retryCount: batchRows.retryCount,
      tenantId: batches.tenantId,
      userId: batches.userId,
    })
    .from(batchRows)
    .innerJoin(batches, eq(batchRows.batchId, batches.id))
    .where(eq(batchRows.id, rowId))
    .limit(1);

  if (!row) return { error: "row 不存在" };
  if (row.tenantId !== tenantId) return { error: "无权限" };
  if (row.status !== "failed") return { error: `仅 failed 行可 retry（当前 ${row.status}）` };

  await db
    .update(batchRows)
    .set({
      status: "pending",
      errorMessage: null,
      retryCount: row.retryCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(batchRows.id, rowId));

  await batchQueue.add(
    "batch-row",
    { batchId: row.batchId, rowId: row.id, tenantId: row.tenantId, userId: row.userId, isRetry: true },
    { jobId: `batch-${row.batchId}-${row.id}-retry-${row.retryCount + 1}` },
  );

  await recomputeBatchProgress(row.batchId);
  logger.info({ rowId, batchId: row.batchId, retryCount: row.retryCount + 1 }, "P4 batch row 手动 retry 入队");
  return { ok: true };
}

// 防止未使用 import 警告（contents 在 schema FK 已用）
void contents;
