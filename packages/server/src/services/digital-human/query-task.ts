/**
 * DVH GetVideoTaskInfo 轮询封装。5min timeout。status RUNNING → 继续 / SUCCESS → 拿 videoUrl / FAIL → 抛。
 */
// @ts-expect-error
import * as $Util from "@alicloud/tea-util";
import { createDvhClient, $avatar20220130 } from "./client.js";
import { logger } from "../../config/logger.js";

export interface DvhQueryResult {
  videoUrl: string;
  durationMs: number;
  totalMs: number;
}

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function queryDvhTaskUntilDone(taskUuid: string): Promise<DvhQueryResult> {
  const dvhTenantId = process.env.DVH_TENANT_ID;
  const appId = process.env.DVH_APP_ID;
  if (!dvhTenantId || !appId) throw new Error("DVH query: DVH_TENANT_ID/DVH_APP_ID 缺失");

  const client = createDvhClient();
  const runtime = new $Util.RuntimeOptions({});
  const startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const req = new $avatar20220130.GetVideoTaskInfoRequest({
      tenantId: parseInt(dvhTenantId, 10),
      app: new $avatar20220130.GetVideoTaskInfoRequestApp({ appId }),
      taskUuid,
    });
    const resp = await client.getVideoTaskInfoWithOptions(req, runtime);
    if (resp.body?.success === false) throw new Error(`DVH query failed: ${resp.body.code} ${resp.body.message}`);

    const status = resp.body?.data?.status?.toUpperCase();
    if (status === "SUCCESS" || status === "SUCCEEDED") {
      const r = resp.body?.data?.taskResult;
      if (!r?.videoUrl) throw new Error(`DVH succeeded but no videoUrl: ${JSON.stringify(resp.body)}`);
      const totalMs = Date.now() - startedAt;
      logger.info({ taskUuid, videoUrl: r.videoUrl, videoDuration: r.videoDuration, totalMs }, "dvh.query.ok");
      return { videoUrl: r.videoUrl, durationMs: (r.videoDuration ?? 0) * 1000, totalMs };
    }
    if (status === "FAIL" || status === "FAILED" || status === "FAILURE") {
      const r = resp.body?.data?.taskResult;
      throw new Error(`DVH task failed: ${r?.failCode} ${r?.failReason}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`DVH query timeout ${POLL_TIMEOUT_MS}ms taskUuid=${taskUuid}`);
}
