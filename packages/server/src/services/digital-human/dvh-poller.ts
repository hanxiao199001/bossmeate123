/**
 * 数字人任务轮询器 —— 表驱动、幂等、重启即续 (9-04 件 2)。
 *
 * 每 5 分钟扫一次 `dvh_tasks` 里 `status='submitted'` 且未超 24h 的行,
 * 每条查一次阿里云, 拿到终态就原子落定。查不到终态就留着下一轮。
 *
 * ## 与旧实现的区别
 *
 * ```
 * 旧: submit → 同一个请求里轮询 10 分钟 → 超时就放弃, 记"孤儿"
 * 新: submit → taskUuid 落库 → 请求结束
 *     轮询器每 5 分钟扫表 → 直到终态 → 上限 24 小时
 * ```
 *
 * 9-03 实测: 10 条"孤儿"里 9 条阿里云早有终态, 1 条(66335e8e)甚至**成功了**
 * 且成片仍可下载 —— 我们只是在 10 分钟处放弃了。
 *
 * ## kind 拆开了(件 2 a)
 *
 * ```
 * dvh_task_failed         阿里云给了 status=4 + failCode  → 常态记录
 * dvh_result_expired      status=6, 结果已过期(9-03 查清)  → 24h 内不该出现
 * dvh_paid_task_orphaned  24 小时内拿不到任何终态          → 应接近 0
 * ```
 *
 * 改完之后 **orphaned 变成真正的异常, failed 变成正常的失败记账**。
 * 现在库里那 10 条 orphaned 有 8 条本该是 failed。
 */

import { logger } from "../../config/logger.js";
import { recordIncident } from "../ops/incidents.js";
import { recordCost } from "../billing/cost-ledger.js";
import { queryDvhTaskOnce } from "./query-task.js";
import {
  listPendingDvhTasks, listOverdueDvhTasks, settleDvhTask, notePoll,
  classifyDvhStatus, isDvhExpiredStatus,
  DVH_SETTLE_DEADLINE_HOURS, type DvhTaskRow,
} from "./dvh-tasks.js";

/** 见 produce-video 的同名常量 */
const DVH_CENTS_PER_SECOND = 16.5;

export interface PollOutcome {
  scanned: number;
  success: number;
  failed: number;
  expired: number;
  orphaned: number;
  stillPending: number;
  queryErrors: number;
}

/** 一轮扫描。整体不抛 —— 单条出错不该让其余的停下来 */
export async function runDvhPollOnce(now: Date = new Date()): Promise<PollOutcome> {
  const out: PollOutcome = { scanned: 0, success: 0, failed: 0, expired: 0, orphaned: 0, stillPending: 0, queryErrors: 0 };

  // ① 先处理超过 24h 仍未落定的 —— 这些才叫孤儿
  for (const t of await listOverdueDvhTasks(now)) {
    if (!await settleDvhTask({ taskUuid: t.taskUuid, status: "orphaned", detail: { reason: "deadline_exceeded" } })) continue;
    out.orphaned += 1;
    void recordIncident({
      kind: "dvh_paid_task_orphaned",
      severity: "error",
      tenantId: t.tenantId,
      /**
       * 🔴 件 2(d): 文案改掉了"可凭 taskUuid 捞回"。
       * 9-03 实测 10 条里只有 1 条真有成片可捞, 8 条阿里云早已判失败 ——
       * **捞无可捞, 那句话把损失说成了待办。**
       */
      message:
        `数字人任务已扣费, ${DVH_SETTLE_DEADLINE_HOURS} 小时内阿里云未给出任何终态(task ${t.taskUuid})` +
        ` —— 需人工去阿里云控制台核对。最后看到的状态: ${t.lastStatus ?? "(从未查到)"}, 已探 ${t.pollCount} 次。`,
      detail: {
        taskUuid: t.taskUuid, title: t.title, templateId: t.templateId,
        lastStatus: t.lastStatus, pollCount: t.pollCount,
        submittedAt: t.submittedAt.toISOString(), estimatedCents: t.estimatedCents,
      },
    });
  }

  // ② 再扫未落定的
  const pending = await listPendingDvhTasks(now);
  out.scanned = pending.length;
  for (const t of pending) {
    try {
      const q = await queryDvhTaskOnce(t.taskUuid);
      await notePoll(t.taskUuid, q.rawStatus);

      if (isDvhExpiredStatus(q.rawStatus)) {
        await settleExpired(t, q.rawStatus, out);
        continue;
      }
      const cls = classifyDvhStatus(q.rawStatus);
      if (cls === "success") { await settleSuccess(t, q, out); continue; }
      if (cls === "failed") { await settleFailed(t, q, out); continue; }
      // 未知态: 继续轮询, 不判失败。detail 里记原始 status(见 classifyDvhStatus 注释)
      out.stillPending += 1;
    } catch (err) {
      // 查询本身失败(网络/账号停用) → 不落定, 下轮再试。计数进 outcome, 由心跳那条看总量。
      out.queryErrors += 1;
      logger.warn({ taskUuid: t.taskUuid, err: err instanceof Error ? err.message : err }, "dvh.poll.query_failed — 本轮跳过, 下轮再试");
    }
  }

  logger.info(out, "9-04 件 2: dvh 轮询完成");
  return out;
}

async function settleSuccess(t: DvhTaskRow, q: { rawStatus: string; videoUrl?: string; durationMs?: number }, out: PollOutcome) {
  const durationMs = q.durationMs ?? 0;
  const actualCents = Math.round((durationMs / 1000) * DVH_CENTS_PER_SECOND);
  if (!await settleDvhTask({
    taskUuid: t.taskUuid, status: "success", lastStatus: q.rawStatus,
    videoUrl: q.videoUrl ?? null, durationMs, actualCents,
  })) return;
  out.success += 1;
  /**
   * 件 2(b) 记账时机: submit 时已按预估记过一笔, 成功时把**实际时长**补记差额。
   * 不重复记全额 —— 那会让 dvh 支出凭空翻倍。
   */
  const delta = actualCents - (t.estimatedCents ?? 0);
  if (delta !== 0) {
    void recordCost({
      tenantId: t.tenantId, kind: "dvh", contentId: t.contentId,
      amountCents: delta, quantity: Math.round(durationMs / 1000),
      note: `DVH实际时长校正 ${(t.title ?? "").slice(0, 40)} (task ${t.taskUuid}) 预估${t.estimatedCents}→实际${actualCents}`,
    });
  }
  logger.info({ taskUuid: t.taskUuid, durationMs, actualCents }, "dvh.poll.settled_success");
}

async function settleFailed(t: DvhTaskRow, q: { rawStatus: string; failCode?: string; failReason?: string }, out: PollOutcome) {
  if (!await settleDvhTask({
    taskUuid: t.taskUuid, status: "failed", lastStatus: q.rawStatus,
    failCode: q.failCode ?? null, failReason: q.failReason ?? null,
  })) return;
  out.failed += 1;
  void recordIncident({
    kind: "dvh_task_failed",
    severity: "error",
    tenantId: t.tenantId,
    message:
      `数字人任务被阿里云判失败(已扣费, 无成片): ${q.failCode ?? "(无 failCode)"} ${q.failReason ?? ""}`.slice(0, 300),
    detail: {
      taskUuid: t.taskUuid, failCode: q.failCode ?? null, failReason: q.failReason ?? null,
      rawStatus: q.rawStatus, title: t.title, templateId: t.templateId,
      estimatedCents: t.estimatedCents,
    },
  });
}

async function settleExpired(t: DvhTaskRow, rawStatus: string, out: PollOutcome) {
  if (!await settleDvhTask({ taskUuid: t.taskUuid, status: "expired", lastStatus: rawStatus })) return;
  out.expired += 1;
  void recordIncident({
    kind: "dvh_result_expired",
    severity: "warn",
    tenantId: t.tenantId,
    /**
     * 🔴 24h 窗口内**不该**看到 status=6。9-03 实测结果保留期是 6~15 天,
     * 所以它出现在这里意味着两件事之一: 阿里云改了语义, 或这条任务是历史灌入的。
     * 无论哪种都要有人看一眼, 因此报 warn 而不是静默落定。
     */
    message:
      `数字人任务结果已过期(status=${rawStatus}, task ${t.taskUuid}) —— ` +
      `阿里云的结果保留期约 6~15 天, 而本任务提交于 ${t.submittedAt.toISOString().slice(0, 10)}。` +
      `${DVH_SETTLE_DEADLINE_HOURS} 小时轮询窗口内出现过期属异常, 需确认是历史灌入还是阿里云语义变更。`,
    detail: { taskUuid: t.taskUuid, rawStatus, submittedAt: t.submittedAt.toISOString(), title: t.title },
  });
}
