/**
 * DVH「合成一条数字人视频」的核心重活 —— 与"文本从哪来"完全无关的那一半。
 *
 * 7-30 从 article-bridge.ts 原样搬出(逻辑一字未改), 因为多了第二个调用方:
 *   - article-bridge.ts  → triggerDvhFromArticle (文章 → videoScript → 视频)
 *   - text-bridge.ts     → triggerDvhFromText    (运营手写口播稿 → 视频)
 *   让 text-bridge 去 import article-bridge 是错的(文字稿链路根本不经过文章),
 *   所以把共用部分提到这里, 两边平级 import。
 *
 * ⚠️ 这里面每一行都在管钱, 改之前先读 produceVideo 的注释:
 *   submit 即扣费 (0.165 元/秒) → 拿到付费产物后任何失败都必须把产物带回去, 绝不退 mock。
 * ⚠️ 命名提醒: services/video/index.ts 里另有一个同名 produceVideo(图片合成视频那条线),
 *   两者毫无关系, 别在同一个文件里同时 import。
 */
import { logger } from "../../config/logger.js";
import { isRealMode } from "./client.js";
import { submitDvhTask, submitDvhAudioTask } from "./submit-task.js";
import { buildSrtFromText } from "./subtitle-from-text.js";
import { ttsService } from "../video/tts-service.js";
import { storage } from "../storage/index.js";
import { queryDvhTaskUntilDone } from "./query-task.js";
import { getMockDvhFixture } from "./mock-fixture.js";
import { postprocessVideoWithSubtitle } from "./video-postprocess.js";
import type { TemplateId } from "./template-mapping.js";
import { checkBudget, estimateDvhCents, recordCost, DVH_CENTS_PER_SECOND } from "../billing/cost-ledger.js";

/**
 * 6-26 音频驱动修: 阿里云要去公网拉音频/字幕, 但本地存储后端返回相对路径 /storage/...
 *   → 拼成公网绝对 URL。OSS 后端已返回绝对 http(s) 则原样返回。
 *   未配 DVH_PUBLIC_BASE 又是相对路径时抛错 —— 在 submit 之前抛, 避免提交不可达资源 = 白扣费产生孤儿任务。
 */
export function toPublicUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = process.env.DVH_PUBLIC_BASE?.replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "DVH_AUDIO_DRIVEN 需要公网可达的音频/字幕 URL, 但本地存储返回相对路径。请设 DVH_PUBLIC_BASE=https://你的域名 (实测 https://boss-mate.cn), 或改用 OSS 存储。",
    );
  }
  return base + (url.startsWith("/") ? url : "/" + url);
}

export interface ProducedVideo {
  videoUrl: string;          // 最终落库 URL (后处理成功=新 OSS, 失败=付费原始 URL, mock=占位)
  rawVideoUrl?: string;      // 阿里云原始付费 mp4 (real 成功才有, 留存以防后处理 URL 失效)
  taskUuid: string;
  orphanTaskUuid?: string;   // 已付费但 query 失败/超时的孤儿任务 — 记下供后续 recover
  durationMs: number;
  postprocessed: boolean;
  realMode: boolean;
}

/**
 * 7-29: 原来是 5 个位置参数 (text, title, templateId, tenantId, clonedVoiceId), 再加背景图就彻底读不懂了
 *   —— 改成 options 对象。
 */
export interface ProduceVideoOptions {
  text: string;
  title: string;
  templateId: TemplateId | string;
  tenantId: string;
  clonedVoiceId?: string;
  /** 背景图公网 URL; DVH_BG_NONE="none" = 显式不要背景 */
  backgroundUrl?: string;
}

export async function produceVideo(opts: ProduceVideoOptions): Promise<ProducedVideo> {
  const { text, title, templateId, tenantId, clonedVoiceId, backgroundUrl } = opts;
  if (!isRealMode()) {
    const m = getMockDvhFixture((templateId in { A_academic: 1, B_marketing: 1, C_popular: 1, E_industry: 1 } ? templateId : "A_academic") as TemplateId);
    return { ...m, rawVideoUrl: undefined, postprocessed: false, realMode: false };
  }
  // PR #261 (5-29): 防烧钱 — submit 即扣费 (0.165 元/秒). 一旦 query 拿到付费 videoUrl,
  //   之后任何失败都绝不退回 mock, 必须把付费产物落库. taskUuid/rawVideoUrl 提到 try 外保命.
  let taskUuid: string | undefined;
  let rawVideoUrl: string | undefined;
  let durationMs = 0;
  // PR-W1 预算闸: submit 即扣费, 所以闸必须在 submit 之前。超限直接抛 — 不退 mock, 让调用方看到原因。
  const gate = await checkBudget(tenantId, estimateDvhCents(text));
  if (!gate.allowed) {
    throw new Error(`BUDGET_EXCEEDED: ${gate.reason}`);
  }
  try {
    // 6-26 音频驱动开关: DVH_AUDIO_DRIVEN=1 → 我们自己合成更自然的音频(CosyVoice2/qwen-tts)驱动数字人
    //   对口型, 替代内置音色(AI 味重)。默认关, 走原文字驱动, 不动现有生产。
    const audioDriven = process.env.DVH_AUDIO_DRIVEN === "1";
    let subtitlesUrl = "";
    if (audioDriven) {
      // 合成音频(走配置的 TTS_PROVIDER, 建议 siliconflow/CosyVoice2 或 dashscope/qwen-tts; 要 wav)
      const tts = await ttsService.synthesize(tenantId, text, { format: "wav", ...(clonedVoiceId ? { voice: clonedVoiceId } : {}) });
      // 阿里云需HTTPS拉音频。OSS私有桶→签名URL(限时有效、不公开); 本地→相对路径转公网base。submit前算好, 不可达直接抛(不白扣费)
      const audioUrl = toPublicUrl(await storage.getSignedUrl(tts.remotePath, 7200));
      const submit = await submitDvhAudioTask({
        audioUrl, templateId, tenantId, title,
        sampleRate: process.env.DVH_AUDIO_SAMPLE_RATE ? parseInt(process.env.DVH_AUDIO_SAMPLE_RATE, 10) : undefined,
        ...(backgroundUrl ? { backgroundUrl } : {}),
      });
      taskUuid = submit.taskUuid;
      const query = await queryDvhTaskUntilDone(taskUuid);
      rawVideoUrl = query.videoUrl;   // ★ 付费产物到手
      durationMs = query.durationMs;
      // 音频驱动 DVH 不返回字幕 → 用口播稿文字 + 视频时长自生成 SRT
      try {
        const srt = buildSrtFromText(text, durationMs || tts.durationMs);
        if (srt) {
          const srtRemote = `tts/${tenantId}/dvhsub-${taskUuid}.srt`;
          await storage.upload(Buffer.from(srt, "utf-8"), srtRemote, "application/x-subrip");
          subtitlesUrl = toPublicUrl(await storage.getSignedUrl(srtRemote, 7200)); // 私有桶签名URL; postprocess 会HTTP下载SRT
        }
      } catch (e) {
        logger.warn({ taskUuid, err: e instanceof Error ? e.message : e }, "dvh.audio.srt_gen_failed");
      }
    } else {
      const submit = await submitDvhTask({ text, templateId, tenantId, title, ...(backgroundUrl ? { backgroundUrl } : {}) });
      taskUuid = submit.taskUuid;
      const query = await queryDvhTaskUntilDone(taskUuid);
      rawVideoUrl = query.videoUrl;   // ★ 付费产物到手 — 此后不可丢
      durationMs = query.durationMs;
      subtitlesUrl = query.subtitlesUrl ?? "";
    }
    // PR-W1 成本台账: 拿到付费产物即记账 (0.165元/秒)。fire-and-forget, 不影响主流程。
    void recordCost({
      tenantId, kind: "dvh",
      amountCents: Math.round((durationMs / 1000) * DVH_CENTS_PER_SECOND),
      quantity: Math.round(durationMs / 1000),
      note: `DVH合成 ${title.slice(0, 50)} (task ${taskUuid})`,
    });
    // PR #252: ffmpeg burn-in 自定义字幕. postprocess 内部已 fallback 原 videoUrl, 正常不抛.
    const pp = await postprocessVideoWithSubtitle({
      videoUrl: rawVideoUrl,
      subtitlesUrl,
      taskUuid,
    });
    return { videoUrl: pp.videoUrl, rawVideoUrl, taskUuid, durationMs, postprocessed: pp.postprocessed, realMode: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ★ 已拿到付费视频却抛错 (理论上 postprocess 已兜底, 此为防御): 用原始付费 URL 落库, 绝不退 mock.
    if (rawVideoUrl) {
      logger.error({ err: msg, taskUuid, rawVideoUrl }, "dvh.bridge.kept_paid_video_despite_error");
      return { videoUrl: rawVideoUrl, rawVideoUrl, taskUuid: taskUuid!, durationMs, postprocessed: false, realMode: true };
    }
    // ★ submit 成功 (已扣费) 但 query 失败/超时: 阿里云任务可能仍在跑/已完成. 记 orphanTaskUuid 供后续 recover, 不静默吞.
    if (taskUuid) {
      logger.error({ err: msg, taskUuid }, "dvh.bridge.paid_task_orphaned_query_failed");
      // PR-W1: submit 已扣费但拿不到实际时长 — 按预估记账, note 标孤儿供核对
      void recordCost({
        tenantId, kind: "dvh",
        amountCents: estimateDvhCents(text),
        note: `DVH孤儿任务(预估) ${title.slice(0, 50)} (task ${taskUuid})`,
      });
      const m = getMockDvhFixture((templateId in { A_academic: 1, B_marketing: 1, C_popular: 1, E_industry: 1 } ? templateId : "A_academic") as TemplateId);
      return { ...m, rawVideoUrl: undefined, orphanTaskUuid: taskUuid, postprocessed: false, realMode: false };
    }
    // submit 都没成功 — 未扣费, 正常 fallback mock.
    logger.warn({ err: msg, templateId }, "dvh.bridge.real_failed_fallback_mock");
    const m = getMockDvhFixture((templateId in { A_academic: 1, B_marketing: 1, C_popular: 1, E_industry: 1 } ? templateId : "A_academic") as TemplateId);
    return { ...m, rawVideoUrl: undefined, postprocessed: false, realMode: false };
  }
}
