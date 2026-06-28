/**
 * DVH SubmitTextTo2DAvatarVideoTask wrapper.
 * 业务级失败 (body.success===false, 5-13 实测 10010003 无访问权限) 抛错给 bridge 决定 fallback。
 *
 * 【成本】(2026-05 实测账单, 阿里云后付费实例 32254)
 *   单价: 0.165 元/秒 (按生成视频实际秒数计费, 无起步价 / 无最小段)
 *   45 秒 ≈ 7.43 元 / 60 秒 ≈ 9.90 元 / 90 秒 ≈ 14.85 元
 *   形象+声音商用授权已一次性付清, 边际成本 = DVH 合成 + ~0.16 元 LLM 写脚本 + ~0.01 元 OSS
 *   省钱主杠杆: 缩短视频时长 (脚本字数 → 视频秒数 → 成本线性下降)
 *   如果阿里云后续调价 / 改资源包 / 改计费方式, 同步更新这里 + memory: dvh-aliyun-virtual-human.md
 */
import * as $Util from "@alicloud/tea-util";
import { createDvhClient, $avatar20220130 } from "./client.js";
import { resolveAvatarVoice, type TemplateId } from "./template-mapping.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";

export interface DvhSubmitOptions {
  text: string;
  templateId: TemplateId | string; // PR-X2: 目录扩展后支持自定义 key
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
  const mapping = await resolveAvatarVoice(String(opts.templateId)); // PR-X2 目录解析
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
      // PR #250 (5-24): 语速 1.3 倍 (老韩反馈默认语速太慢). 阿里云 speechRate 范围 -500~500 (0=1.0x).
      // PR #259 (5-28): 1.3x 老韩反馈太快, 降到 1.1x 中等节奏 (抖音口播常见档位).
      //   150 → 50. 听感觉再微调 (太慢回 75/100, 太快降到 25/0).
      speechRate: env.DVH_SPEECH_RATE, // PR-E: 配置化 (原硬编码 50≈1.1x)
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


/**
 * 6-26 音频驱动: 用我们自己合成的更自然音频(CosyVoice2/qwen-tts)驱动数字人对口型,
 *   替代 submitTextTo2D 的内置音色(AI 味重)。音频 URL 走顶层 url 字段。
 *   注意: 音频驱动 DVH 不返回字幕 SRT, 字幕由 buildSrtFromText 自生成后 burn-in。
 */
export async function submitDvhAudioTask(opts: {
  audioUrl: string; templateId: TemplateId | string; tenantId: string; title?: string; sampleRate?: number;
}): Promise<DvhSubmitResult> {
  const dvhTenantId = process.env.DVH_TENANT_ID;
  const appId = process.env.DVH_APP_ID;
  if (!dvhTenantId) throw new Error("DVH_TENANT_ID 缺失");
  if (!appId) throw new Error("DVH_APP_ID 缺失");
  const mapping = await resolveAvatarVoice(String(opts.templateId));
  if (!mapping) throw new Error(`DVH templateId 不存在: ${opts.templateId}`);

  const client = createDvhClient();
  const backgroundImageUrl = mapping.backgroundUrl || process.env.DVH_DEFAULT_BG_URL || undefined;
  const safeTitle = ((opts.title || `BossMate DVH ${opts.templateId}`) as string).slice(0, 60);
  const req = new $avatar20220130.SubmitAudioTo2DAvatarVideoTaskRequest({
    tenantId: parseInt(dvhTenantId, 10),
    app: new $avatar20220130.SubmitAudioTo2DAvatarVideoTaskRequestApp({ appId }),
    title: safeTitle,
    url: opts.audioUrl, // 顶层 url = 音频 URL(须 HTTPS 公网可达)
    avatarInfo: new $avatar20220130.SubmitAudioTo2DAvatarVideoTaskRequestAvatarInfo({ code: mapping.avatarCode }),
    audioInfo: new $avatar20220130.SubmitAudioTo2DAvatarVideoTaskRequestAudioInfo({
      // 阿里云对采样率有要求(常见 16000), 首次渲染若报音频格式错就调这里(env DVH_AUDIO_SAMPLE_RATE)
      sampleRate: opts.sampleRate ?? 16000,
    }),
    videoInfo: new $avatar20220130.SubmitAudioTo2DAvatarVideoTaskRequestVideoInfo({
      isAlpha: false,
      ...(backgroundImageUrl ? { backgroundImageUrl } : {}),
    }),
  });

  const startedAt = Date.now();
  const resp = await client.submitAudioTo2DAvatarVideoTaskWithOptions(req, new $Util.RuntimeOptions({}));
  const submitMs = Date.now() - startedAt;

  if (resp.body?.success === false) {
    const e = new Error(`DVH audio submit failed: ${resp.body.code} ${resp.body.message}`) as Error & { code?: string; requestId?: string };
    e.code = resp.body.code;
    e.requestId = resp.body.requestId;
    throw e;
  }
  const taskUuid = resp.body?.data?.taskUuid;
  if (!taskUuid) throw new Error(`DVH audio submit no taskUuid: ${JSON.stringify(resp.body)}`);

  logger.info(
    { taskUuid, submitMs, mode: "audio-driven", templateId: opts.templateId, avatarLabel: mapping.avatarLabel, tenantId: opts.tenantId },
    "dvh.submit.audio.ok",
  );
  return { taskUuid, submitMs, requestId: resp.body?.requestId };
}
