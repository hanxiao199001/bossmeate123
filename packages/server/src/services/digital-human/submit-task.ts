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
import { DVH_BG_NONE, assertBackgroundReachable } from "./background-library.js";

export interface DvhSubmitOptions {
  text: string;
  templateId: TemplateId | string; // PR-X2: 目录扩展后支持自定义 key
  tenantId: string;
  title?: string;
  /**
   * 7-29 单次生成指定背景图 (系统图库选的 / 运营本地上传的公网 URL)。
   * 传 DVH_BG_NONE("none") = 本次显式不要背景(压掉 mapping/env 上配的), 回 DVH 默认黑底。
   */
  backgroundUrl?: string;
  /**
   * 7-31 存证用: 调用方(运营)本次**请求**的音色 voice_id。
   * ⚠️ 文字驱动这条路根本不用它 —— 阿里云 AudioInfo.voice 只认平台发音人 code(aixia/maoxiaomei…),
   *   而我们音色库里存的是 TTS 侧的 voice_id(qwen-tts/cosyvoice 命名空间), 两套东西不通用, 硬塞会 submit 失败。
   *   收进来只为了在日志/存证里写清"用户要的是 X, 实际用的是 Y", 否则这条永远只能靠猜。
   */
  requestedVoiceId?: string;
}

/**
 * 7-31 **实际发给阿里云**的那一份参数 —— 与"用户选了什么"严格分开。
 *
 * 【为什么必须单独有这个】老板实测"形象/背景/音色全不生效"时, 唯一能查的是 metadata,
 *   而当时 metadata 里记的是 resolveAvatarVoice(templateId) 重新算出来的值 = "本该用什么",
 *   不是"真用了什么"。两者在 mock 兜底 / 背景被 none 短路 / 音色被忽略时会完全不同,
 *   结果就是查证时看到一份"参数都对"的记录, 而片子是另一回事。
 */
export interface DvhEffectiveParams {
  /** text = SubmitTextTo2DAvatarVideoTask(默认); audio = DVH_AUDIO_DRIVEN=1 的音频驱动 */
  driveMode: "text" | "audio";
  avatarCode: string;
  avatarLabel: string;
  /** 文字驱动 = 真正塞进 AudioInfo.voice 的平台发音人; 音频驱动 = 我们 TTS 用的 voice */
  voiceCode: string;
  voiceLabel?: string;
  /** 真正塞进 VideoInfo.backgroundImageUrl 的值; 没有 = 这次压根没传背景(黑底) */
  backgroundImageUrl?: string;
  /** 调用方本次请求的背景("none" 也算), 与上一行不同就说明被优先级链改写了 */
  requestedBackgroundUrl?: string;
  /** 有值 = 用户选了音色但这条路把它忽略了(文字驱动的既定限制) */
  ignoredVoiceRequest?: string;
}

export interface DvhSubmitResult {
  taskUuid: string;
  submitMs: number;
  requestId?: string;
  /** 7-31 本次真正生效的参数(供上游落 metadata; 不是用户选的那一份) */
  effective: DvhEffectiveParams;
}

/**
 * 7-29 背景图优先级链: 单次指定 (opts.backgroundUrl) > 形象自带 (mapping.backgroundUrl)
 *   > 全局默认 (env DVH_DEFAULT_BG_URL) > undefined (DVH 默认黑底)。
 * 哨兵 DVH_BG_NONE 短路整条链 —— 否则运营选了"不用背景"还是会被 mapping/env 顶回来。
 * (原 PR #243 只有后两级; 单次生成无法指定, 7-29 补上第一级。)
 */
export function resolveBackgroundUrl(optUrl?: string, mappingUrl?: string): string | undefined {
  if (optUrl === DVH_BG_NONE) return undefined;
  return optUrl || mappingUrl || process.env.DVH_DEFAULT_BG_URL || undefined;
}

export async function submitDvhTask(opts: DvhSubmitOptions): Promise<DvhSubmitResult> {
  const dvhTenantId = process.env.DVH_TENANT_ID;
  const appId = process.env.DVH_APP_ID;
  if (!dvhTenantId) throw new Error("DVH_TENANT_ID 缺失");
  if (!appId) throw new Error("DVH_APP_ID 缺失");
  const mapping = await resolveAvatarVoice(String(opts.templateId)); // PR-X2 目录解析
  if (!mapping) throw new Error(`DVH templateId 不存在: ${opts.templateId}`);

  const client = createDvhClient();
  // PR #243 → 7-29 扩展: 背景图选型 — 单次指定 > per-template > env 全局 > undefined (走 DVH 默认黑底)
  const backgroundImageUrl = resolveBackgroundUrl(opts.backgroundUrl, mapping.backgroundUrl);
  // 7-29 可达性预检: submit 即扣费, 拉不到的背景图阿里云多半静默黑底(钱照扣)。在花钱之前拦掉。
  if (backgroundImageUrl) await assertBackgroundReachable(backgroundImageUrl);
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

  // 7-31 🔴 花钱之前把"真正发出去的三件"打一条 info —— 出片不对时不必再猜是哪一层丢的。
  //   注意打的是 req 里那份值, 不是入参: 中间任何一层改写(优先级链/哨兵/mapping 兜底)都会体现在这。
  const effective: DvhEffectiveParams = {
    driveMode: "text",
    avatarCode: mapping.avatarCode,
    avatarLabel: mapping.avatarLabel,
    voiceCode: mapping.voiceCode,
    voiceLabel: mapping.voiceLabel,
    ...(backgroundImageUrl ? { backgroundImageUrl } : {}),
    ...(opts.backgroundUrl ? { requestedBackgroundUrl: opts.backgroundUrl } : {}),
    // 文字驱动只认 mapping.voiceCode, 用户选的音色在这条路上一定被忽略 —— 明写出来, 别让人再查一遍
    ...(opts.requestedVoiceId ? { ignoredVoiceRequest: opts.requestedVoiceId } : {}),
  };
  logger.info(
    { tenantId: opts.tenantId, templateId: opts.templateId, ...effective, speechRate: env.DVH_SPEECH_RATE },
    "dvh.submit.params",
  );

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
  return { taskUuid, submitMs, requestId: resp.body?.requestId, effective };
}


/**
 * 6-26 音频驱动: 用我们自己合成的更自然音频(CosyVoice2/qwen-tts)驱动数字人对口型,
 *   替代 submitTextTo2D 的内置音色(AI 味重)。音频 URL 走顶层 url 字段。
 *   注意: 音频驱动 DVH 不返回字幕 SRT, 字幕由 buildSrtFromText 自生成后 burn-in。
 */
export async function submitDvhAudioTask(opts: {
  audioUrl: string; templateId: TemplateId | string; tenantId: string; title?: string; sampleRate?: number;
  /** 7-29 同 submitDvhTask: 单次指定背景图; DVH_BG_NONE = 显式不要背景 */
  backgroundUrl?: string;
  /** 7-31 存证: 这条音频是用哪个音色合的(音频驱动下音色**真生效**, 与文字驱动相反) */
  ttsVoice?: string;
}): Promise<DvhSubmitResult> {
  const dvhTenantId = process.env.DVH_TENANT_ID;
  const appId = process.env.DVH_APP_ID;
  if (!dvhTenantId) throw new Error("DVH_TENANT_ID 缺失");
  if (!appId) throw new Error("DVH_APP_ID 缺失");
  const mapping = await resolveAvatarVoice(String(opts.templateId));
  if (!mapping) throw new Error(`DVH templateId 不存在: ${opts.templateId}`);

  const client = createDvhClient();
  // 7-29: 与文本驱动分支同一条优先级链 + 同一道可达性预检 (两个分支必须一致, 否则开关 DVH_AUDIO_DRIVEN 就换了行为)
  const backgroundImageUrl = resolveBackgroundUrl(opts.backgroundUrl, mapping.backgroundUrl);
  if (backgroundImageUrl) await assertBackgroundReachable(backgroundImageUrl);
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

  // 7-31 与文字驱动同一条存证: 音频驱动下 voiceCode = 我们 TTS 真正用的音色(这条路才换得动声音)
  const effective: DvhEffectiveParams = {
    driveMode: "audio",
    avatarCode: mapping.avatarCode,
    avatarLabel: mapping.avatarLabel,
    voiceCode: opts.ttsVoice || "(TTS 默认音色)",
    ...(backgroundImageUrl ? { backgroundImageUrl } : {}),
    ...(opts.backgroundUrl ? { requestedBackgroundUrl: opts.backgroundUrl } : {}),
  };
  logger.info(
    { tenantId: opts.tenantId, templateId: opts.templateId, ...effective, audioUrl: opts.audioUrl },
    "dvh.submit.params",
  );

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
  return { taskUuid, submitMs, requestId: resp.body?.requestId, effective };
}
