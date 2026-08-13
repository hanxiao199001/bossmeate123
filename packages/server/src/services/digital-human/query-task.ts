/**
 * DVH GetVideoTaskInfo 轮询封装。5min timeout。status RUNNING → 继续 / SUCCESS → 拿 videoUrl / FAIL → 抛。
 */
import * as $Util from "@alicloud/tea-util";
import { createDvhClient, $avatar20220130 } from "./client.js";
import { logger } from "../../config/logger.js";

export interface DvhQueryResult {
  videoUrl: string;
  durationMs: number;
  totalMs: number;
  // PR #252: SRT 字幕 URL (DVH 返回, ffmpeg 后处理用)
  subtitlesUrl?: string;
}

const POLL_INTERVAL_MS = 5000;
// PR #238 (5-23): timeout 从 5min 延到 10min — 阿里云 2D 数字人长文本(>500字)渲染常超 5min.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 8-13 任务被阿里云**明确判失败**（不是"查不到"）。
 *
 * 🔴 与 `DvhOrphanTaskError` 是两回事，别再合并：
 *   · 本错误 = 接口好好回了话，告诉我们 status=4 + failCode + failReason。**没有成片，捞无可捞。**
 *   · 孤儿   = 查询本身挂了/超时，任务可能还在跑，taskUuid 有捞回价值。
 * 8-13 之前两者都被 `if (taskUuid)` 归成孤儿，于是 5 条 10010002 全带着
 * 「可凭 taskUuid 去阿里云捞回」这条**错误指引**躺在 incident 里。
 * **API 给的原因永远优先于我们的猜测** —— failCode/failReason 一路带到 errorMessage。
 */
export class DvhTaskFailedError extends Error {
  readonly taskUuid: string;
  readonly failCode: string;
  readonly failReason: string;
  readonly rawStatus: string;
  constructor(args: { taskUuid: string; failCode: string; failReason: string; rawStatus: string }) {
    super(`DVH_TASK_FAILED: status=${args.rawStatus} ${args.failCode} ${args.failReason}`.trim());
    this.name = "DvhTaskFailedError";
    this.taskUuid = args.taskUuid;
    this.failCode = args.failCode;
    this.failReason = args.failReason;
    this.rawStatus = args.rawStatus;
  }
}

/**
 * 状态归一 —— **一处定义，两种形态通吃**。
 *
 * 阿里云这个字段有前科：PR #239 按 `typeof === "number"` 判，实测回的是字符串 "3" 而漏过；
 * PR #240 才改成 `Number()`。为免第三次踩，判定收口到这一个函数并加测试。
 */
export function normalizeDvhStatus(raw: unknown): { text: string; num: number } {
  const text = String(raw ?? "").trim().toUpperCase();
  const n = Number(raw);
  return { text, num: Number.isFinite(n) ? n : Number.NaN };
}

export function isDvhSuccessStatus(raw: unknown): boolean {
  const { text, num } = normalizeDvhStatus(raw);
  return text === "SUCCESS" || text === "SUCCEEDED" || num === 3;
}

export function isDvhFailStatus(raw: unknown): boolean {
  const { text, num } = normalizeDvhStatus(raw);
  return text === "FAIL" || text === "FAILED" || text === "FAILURE" || (Number.isFinite(num) && num >= 4);
}

export async function queryDvhTaskUntilDone(taskUuid: string): Promise<DvhQueryResult> {
  const dvhTenantId = process.env.DVH_TENANT_ID;
  const appId = process.env.DVH_APP_ID;
  if (!dvhTenantId || !appId) throw new Error("DVH query: DVH_TENANT_ID/DVH_APP_ID 缺失");

  const client = createDvhClient();
  const runtime = new $Util.RuntimeOptions({});
  const startedAt = Date.now();
  let pollCount = 0;
  let lastStatus = "";

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    pollCount += 1;
    const req = new $avatar20220130.GetVideoTaskInfoRequest({
      tenantId: parseInt(dvhTenantId, 10),
      app: new $avatar20220130.GetVideoTaskInfoRequestApp({ appId }),
      taskUuid,
    });
    const resp = await client.getVideoTaskInfoWithOptions(req, runtime);
    if (resp.body?.success === false) {
      logger.warn({ taskUuid, code: resp.body.code, message: resp.body.message, pollCount }, "dvh.query.api_failed");
      throw new Error(`DVH query failed: ${resp.body.code} ${resp.body.message}`);
    }

    // PR #239 (5-23): 阿里云 GetVideoTaskInfo 实测返回 status=数字 (1 排队 / 2 渲染 / 3 完成 / 4+ 失败).
    //   PR #240 (5-23): 实测 status 是**字符串** "3" (而非数字 3), PR #239 用 typeof === "number"
    //     拿到 NaN 又漏过. 改 Number(rawStatus) 通吃数字 + 数字字符串.
    const rawStatus = resp.body?.data?.status;
    const statusStr = String(rawStatus ?? "").toUpperCase();
    const statusNumRaw = Number(rawStatus);
    const statusNum = Number.isFinite(statusNumRaw) ? statusNumRaw : Number.NaN;
    // PR #238: 状态变化或每 6 次 poll(30s)记一次日志, 方便追长任务进度.
    if (statusStr !== lastStatus || pollCount % 6 === 0) {
      logger.info({ taskUuid, status: rawStatus, statusStr, statusNum, pollCount, elapsedMs: Date.now() - startedAt }, "dvh.query.poll");
      lastStatus = statusStr;
    }
    // 成功: 字符串 SUCCESS/SUCCEEDED  或  数字 3
    if (isDvhSuccessStatus(rawStatus)) {
      const r = resp.body?.data?.taskResult;
      if (!r?.videoUrl) throw new Error(`DVH succeeded but no videoUrl: ${JSON.stringify(resp.body)}`);
      const totalMs = Date.now() - startedAt;
      logger.info({ taskUuid, videoUrl: r.videoUrl, subtitlesUrl: r.subtitlesUrl, videoDuration: r.videoDuration, totalMs, pollCount }, "dvh.query.ok");
      return {
        videoUrl: r.videoUrl,
        // PR #268 (5-29): 阿里云 videoDuration 实测就是**毫秒** (0:39 视频返回 39040). 原 *1000 导致 1000 倍放大
        //   (前端显示 39040s). 直接当 ms 用.
        durationMs: r.videoDuration ?? 0,
        totalMs,
        subtitlesUrl: r.subtitlesUrl, // PR #252: SRT 字幕给 ffmpeg
      };
    }
    // 失败: 字符串 FAIL/FAILED/FAILURE  或  数字 ≥4 (阿里云用数字 4+ 表失败, 待真实样本确认)
    if (isDvhFailStatus(rawStatus)) {
      const r = resp.body?.data?.taskResult;
      logger.warn({ taskUuid, status: rawStatus, failCode: r?.failCode, failReason: r?.failReason, pollCount }, "dvh.query.task_failed");
      // 8-13: 改抛类型化错误 —— 原来抛裸 Error, 上层 `if (taskUuid)` 一律当孤儿,
      //   API 明明白白给的 failCode/failReason 就此蒸发(5 条 10010002 全被归成"取不回")。
      throw new DvhTaskFailedError({
        taskUuid,
        failCode: String(r?.failCode ?? ""),
        failReason: String(r?.failReason ?? ""),
        rawStatus: String(rawStatus ?? ""),
      });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  logger.warn({ taskUuid, pollCount, lastStatus, timeoutMs: POLL_TIMEOUT_MS }, "dvh.query.timeout");
  throw new Error(`DVH query timeout ${POLL_TIMEOUT_MS}ms taskUuid=${taskUuid} lastStatus=${lastStatus} polls=${pollCount}`);
}
