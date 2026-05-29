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
    if (statusStr === "SUCCESS" || statusStr === "SUCCEEDED" || statusNum === 3) {
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
    if (statusStr === "FAIL" || statusStr === "FAILED" || statusStr === "FAILURE" || (Number.isFinite(statusNum) && statusNum >= 4)) {
      const r = resp.body?.data?.taskResult;
      logger.warn({ taskUuid, status: rawStatus, failCode: r?.failCode, failReason: r?.failReason, pollCount }, "dvh.query.task_failed");
      throw new Error(`DVH task failed: status=${rawStatus} ${r?.failCode ?? ""} ${r?.failReason ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  logger.warn({ taskUuid, pollCount, lastStatus, timeoutMs: POLL_TIMEOUT_MS }, "dvh.query.timeout");
  throw new Error(`DVH query timeout ${POLL_TIMEOUT_MS}ms taskUuid=${taskUuid} lastStatus=${lastStatus} polls=${pollCount}`);
}
