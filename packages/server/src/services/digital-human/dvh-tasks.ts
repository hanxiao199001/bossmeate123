/**
 * 数字人任务状态表 —— 提交与轮询解耦 (9-04 件 2)。
 *
 * ## 为什么存在
 *
 * 30 天内 ¥169.31(占 DVH 支出 **42.4%**)记为"孤儿任务", 告警文案写着
 * 「可凭该 taskUuid 去阿里云捞回」。9-03 逐个查了那 10 个 taskUuid, 真相是:
 *
 * ```
 * 7 条  status=4  10010002 图片分辨率必须与输出的视频分辨率一致
 * 1 条  status=4  10050005 任务处理超时
 * 1 条  status=3  **其实成功了**, 有成片, 实测 HTTP 206 可下
 * 1 条  status=6  结果已过期
 * ```
 *
 * **10 条里 9 条阿里云早就有终态了 —— 我们只是没等到。**
 * "取不回"是我们的描述, 不是阿里云的状态。而 8-13 特意加的 `DvhTaskFailedError`
 * 分支(注释写着"5 条 10010002 全被归成取不回")**至今 0 次执行**, 因为 10 分钟
 * 轮询超时总是先到。
 *
 * > 🔴 真正的病根: **一个付了钱的异步任务, 它的生命周期被绑在了一个 HTTP 请求上。**
 * > 请求可以超时、进程可以重启、部署可以打断 —— 而那笔钱已经花出去了,
 * > 任务在阿里云那边还在跑。
 *
 * ## 设计
 *
 * ```
 * submit 成功 → 立刻落库(status='submitted') → 请求结束
 * 轮询任务(每 5 分钟) → 扫 status='submitted' 且 submittedAt > now()-24h
 *                    → 查阿里云 → 终态则原子落定 → 未落定留待下轮
 * ```
 *
 * 不依赖任何内存状态、不依赖请求是否还活着。**进程重启后照样接着扫。**
 *
 * ## 单一写者
 *
 * 落定一律走 `UPDATE ... WHERE task_uuid=$1 AND status='submitted'`。
 * **影响行数 = 0 → 说明别人先落定了**: 本次不再记 incident、不再记账, 直接返回。
 * 过渡期里"老的请求内轮询"和"新的定时任务"会同时存在, 没有这一条就会双写 ——
 * 同一个任务记两笔账、发两条告警。
 */

import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { logger } from "../../config/logger.js";

/** 24 小时上限 —— 不是 10 分钟。见文件头 */
export const DVH_SETTLE_DEADLINE_HOURS = 24;
/** 轮询间隔(分钟) */
export const DVH_POLL_INTERVAL_MINUTES = 5;

export type DvhTaskStatus = "submitted" | "success" | "failed" | "expired" | "orphaned";

export interface DvhTaskRow {
  taskUuid: string;
  tenantId: string;
  contentId: string | null;
  status: DvhTaskStatus;
  submittedAt: Date;
  pollCount: number;
  lastStatus: string | null;
  estimatedCents: number | null;
  title: string | null;
  templateId: string | null;
}

/**
 * 阿里云 status 的分类。
 *
 * 🔴 只有 3 和 4 是终态。**其余一律"未知", 继续轮询, 不判失败。**
 *
 * 原来的 `isDvhFailStatus` 是 `num >= 4`, 所以 status=6 会被判成失败 ——
 * 但它没有 failCode/failReason, 落库就是两个空字段。
 * `>= 4` 是把「不认识」当成了「失败」, 与红线 #14 同族:
 * 一个我们没见过的状态, 被写成了一个我们熟悉的结论。
 *
 * 9-03 实测已经查清 6 是什么: **结果已过期清理**(任务记录还在, taskResult 没了)。
 * 抽了 30 天内全部 20 笔正常成功的扣费, 8-19 及更早全是 status=6 无成片;
 * 8-28 那条(6 天前)仍是 status=3 有成片。**结果保留期在 6~15 天之间**,
 * 而任务记录本身至少保留 79 天。
 *
 * 所以在 24h 轮询窗口内**绝不该**看到 6 —— 真看到了那才是异常, 要报。
 */
export function classifyDvhStatus(raw: unknown): "success" | "failed" | "unknown" {
  const t = String(raw ?? "").trim().toUpperCase();
  const n = Number(raw);
  if (t === "SUCCESS" || t === "SUCCEEDED" || n === 3) return "success";
  if (t === "FAIL" || t === "FAILED" || t === "FAILURE" || n === 4) return "failed";
  return "unknown";
}

/** 结果已过期(9-03 查清: status=6)。与"失败"记账口径不同 —— 它当时可能是成功的 */
export function isDvhExpiredStatus(raw: unknown): boolean {
  return Number(raw) === 6;
}

/** submit 成功后立刻调用。落库失败**必须抛** —— 落不上库的任务就是下一个孤儿 */
export async function recordDvhSubmit(p: {
  taskUuid: string; tenantId: string; contentId?: string | null;
  estimatedCents: number; title?: string; templateId?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO dvh_tasks (task_uuid, tenant_id, content_id, status, estimated_cents, title, template_id)
    VALUES (${p.taskUuid}, ${p.tenantId}, ${p.contentId ?? null}, 'submitted',
            ${p.estimatedCents}, ${(p.title ?? "").slice(0, 200)}, ${p.templateId ?? null})
    ON CONFLICT (task_uuid) DO NOTHING
  `);
  logger.info({ taskUuid: p.taskUuid, estimatedCents: p.estimatedCents }, "dvh.task.submitted_recorded");
}

/** 轮询任务取件: 未落定且未超 24h 的 */
export async function listPendingDvhTasks(now: Date = new Date(), limit = 50): Promise<DvhTaskRow[]> {
  const cutoff = new Date(now.getTime() - DVH_SETTLE_DEADLINE_HOURS * 3600_000).toISOString();
  const res = await db.execute(sql`
    SELECT task_uuid, tenant_id, content_id, status, submitted_at, poll_count, last_status,
           estimated_cents, title, template_id
    FROM dvh_tasks
    WHERE status = 'submitted' AND submitted_at > ${cutoff}
    ORDER BY submitted_at ASC LIMIT ${limit}
  `);
  return mapRows(res);
}

/** 超过 24h 仍未落定的 —— 这些才叫孤儿 */
export async function listOverdueDvhTasks(now: Date = new Date(), limit = 50): Promise<DvhTaskRow[]> {
  const cutoff = new Date(now.getTime() - DVH_SETTLE_DEADLINE_HOURS * 3600_000).toISOString();
  const res = await db.execute(sql`
    SELECT task_uuid, tenant_id, content_id, status, submitted_at, poll_count, last_status,
           estimated_cents, title, template_id
    FROM dvh_tasks
    WHERE status = 'submitted' AND submitted_at <= ${cutoff}
    ORDER BY submitted_at ASC LIMIT ${limit}
  `);
  return mapRows(res);
}

function mapRows(res: unknown): DvhTaskRow[] {
  const rows = (res as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return rows.map((r) => ({
    taskUuid: String(r.task_uuid),
    tenantId: String(r.tenant_id),
    contentId: r.content_id ? String(r.content_id) : null,
    status: String(r.status) as DvhTaskStatus,
    submittedAt: new Date(String(r.submitted_at)),
    pollCount: Number(r.poll_count ?? 0),
    lastStatus: r.last_status == null ? null : String(r.last_status),
    estimatedCents: r.estimated_cents == null ? null : Number(r.estimated_cents),
    title: r.title == null ? null : String(r.title),
    templateId: r.template_id == null ? null : String(r.template_id),
  }));
}

/**
 * 🔴 单一写者: 原子落定。
 *
 * 返回 false = 影响行数 0 = **别人先落定了**。调用方据此跳过记账与告警。
 * 没有这一条, 过渡期里请求内轮询与定时任务会把同一个任务记两笔账、发两条告警。
 */
export async function settleDvhTask(p: {
  taskUuid: string;
  status: Exclude<DvhTaskStatus, "submitted">;
  lastStatus?: string | null;
  failCode?: string | null;
  failReason?: string | null;
  videoUrl?: string | null;
  durationMs?: number | null;
  actualCents?: number | null;
  detail?: Record<string, unknown>;
}): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE dvh_tasks SET
      status = ${p.status},
      settled_at = NOW(),
      updated_at = NOW(),
      last_status = COALESCE(${p.lastStatus ?? null}, last_status),
      fail_code = ${p.failCode ?? null},
      fail_reason = ${(p.failReason ?? "").slice(0, 300) || null},
      video_url = ${p.videoUrl ?? null},
      duration_ms = ${p.durationMs ?? null},
      actual_cents = ${p.actualCents ?? null},
      detail = detail || ${JSON.stringify(p.detail ?? {})}::jsonb
    WHERE task_uuid = ${p.taskUuid} AND status = 'submitted'
  `);
  const affected = (res as { rowCount?: number; rows?: unknown[] }).rowCount
    ?? ((res as { rows?: unknown[] }).rows?.length ?? 0);
  if (!affected) {
    logger.info({ taskUuid: p.taskUuid, status: p.status }, "dvh.task.settle_skipped — 已被别处落定(单一写者)");
    return false;
  }
  return true;
}

/** 每轮轮询后记一次, 用于"这条已经探了几次、最后看到什么状态" */
export async function notePoll(taskUuid: string, lastStatus: unknown): Promise<void> {
  await db.execute(sql`
    UPDATE dvh_tasks
    SET poll_count = poll_count + 1, last_polled_at = NOW(), updated_at = NOW(),
        last_status = ${String(lastStatus ?? "").slice(0, 32) || null}
    WHERE task_uuid = ${taskUuid} AND status = 'submitted'
  `);
}
