/**
 * DVH SubmitTextTo2DAvatarVideoTask wrapper.
 * 业务级失败 (body.success===false, 5-13 实测 10010003 无访问权限) 抛错给 bridge 决定 fallback。
 */
import * as $Util from "@alicloud/tea-util";
import { createDvhClient, $avatar20220130 } from "./client.js";
import { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId } from "./template-mapping.js";
import { logger } from "../../config/logger.js";

export interface DvhSubmitOptions {
  text: string;
  templateId: TemplateId;
  tenantId: string;
  title?: string;
}

export interface DvhSubmitResult {
  taskUuid: string;
  submitMs: number;
  requestId?: string;
}

export async function submitDvhTask(opts: DvhSubmitOptions): Promise<DvhSubmitResult> {
  const dvhTenantId = process.env.DVH_TENANT_ID;
  const appId = process.env.DVH_APP_ID;
  if (!dvhTenantId) throw new Error("DVH_TENANT_ID 缺失");
  if (!appId) throw new Error("DVH_APP_ID 缺失");
  const mapping = TEMPLATE_AVATAR_VOICE_MAP[opts.templateId];
  if (!mapping) throw new Error(`DVH templateId 不存在: ${opts.templateId}`);

  const client = createDvhClient();
  // PR #243: 背景图选型 — per-template > env 全局 > undefined (走 DVH 默认黑底)
  const backgroundImageUrl = mapping.backgroundUrl || process.env.DVH_DEFAULT_BG_URL || undefined;
  const req = new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequest({
    tenantId: parseInt(dvhTenantId, 10),
    app: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestApp({ appId }),
    title: opts.title || `BossMate DVH ${opts.templateId}`,
    text: opts.text,
    avatarInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestAvatarInfo({ code: mapping.avatarCode }),
    audioInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestAudioInfo({ voice: mapping.voiceCode }),
    videoInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestVideoInfo({
      isAlpha: false,
      subtitleEmbedded: false,
      ...(backgroundImageUrl ? { backgroundImageUrl } : {}),  // PR #243
    }),
  });
  if (backgroundImageUrl) {
    logger.debug({ templateId: opts.templateId, backgroundImageUrl }, "dvh.submit.with_bg");
  }

  const startedAt = Date.now();
  const resp = await client.submitTextTo2DAvatarVideoTaskWithOptions(req, new $Util.RuntimeOptions({}));
  const submitMs = Date.now() - startedAt;

  if (resp.body?.success === false) {
    const e = new Error(`DVH submit failed: ${resp.body.code} ${resp.body.message}`) as Error & { code?: string; requestId?: string };
    e.code = resp.body.code;
    e.requestId = resp.body.requestId;
    throw e;
  }
  const taskUuid = resp.body?.data?.taskUuid;
  if (!taskUuid) throw new Error(`DVH submit no taskUuid: ${JSON.stringify(resp.body)}`);

  logger.info(
    { taskUuid, submitMs, templateId: opts.templateId, avatarLabel: mapping.avatarLabel, tenantId: opts.tenantId },
    "dvh.submit.ok",
  );
  return { taskUuid, submitMs, requestId: resp.body?.requestId };
}
