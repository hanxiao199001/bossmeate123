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
  // PR #244 (5-23): title 截 ≤ 60 字 (阿里云 DVH 限 64 字, 留 4 字 buffer)
  //   article.title 通常 18-40 字 (PR #185 限制), 但含长期刊名+钩子组合可能超 60.
  const safeTitle = ((opts.title || `BossMate DVH ${opts.templateId}`) as string).slice(0, 60);
  const req = new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequest({
    tenantId: parseInt(dvhTenantId, 10),
    app: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestApp({ appId }),
    title: safeTitle,
    text: opts.text,
    avatarInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestAvatarInfo({ code: mapping.avatarCode }),
    audioInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestAudioInfo({
      voice: mapping.voiceCode,
      // PR #250 (5-24): 语速 1.3 倍 (老韩反馈默认语速太慢). 阿里云 speechRate 范围 -500~500 (0=1.0x),
      //   150 ≈ 1.3x. 听感觉太快/太慢再微调.
      speechRate: 150,
    }),
    videoInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestVideoInfo({
      isAlpha: false,
      // PR #252 (5-24): 关闭 DVH 内嵌字幕 — 阿里云颜色不可控 (PR #251 试过 6 种格式).
      //   改 ffmpeg 后处理: 拿 taskResult.subtitlesUrl (SRT) 用自定义样式 burn-in.
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
