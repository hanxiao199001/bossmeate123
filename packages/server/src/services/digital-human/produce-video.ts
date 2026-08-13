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
import { env } from "../../config/env.js";
import { isRealMode } from "./client.js";
import { submitDvhTask, submitDvhAudioTask } from "./submit-task.js";
import { buildSrtFromText } from "./subtitle-from-text.js";
import { ttsService } from "../video/tts-service.js";
import { storage } from "../storage/index.js";
import { queryDvhTaskUntilDone } from "./query-task.js";
import { getMockDvhFixture } from "./mock-fixture.js";
import { postprocessVideoWithSubtitle } from "./video-postprocess.js";
import type { TemplateId } from "./template-mapping.js";
import type { DvhEffectiveParams } from "./submit-task.js";
import { checkBudget, estimateDvhCents, recordCost, DVH_CENTS_PER_SECOND } from "../billing/cost-ledger.js";
import { recordIncident, recordIncidentThrottled } from "../ops/incidents.js";

/**
 * 7-31 TTS 合成失败 → **主动中止**, 不提交阿里云。
 *
 * 与 BUDGET_EXCEEDED 同一档的"硬失败": 绝不退占位样片, 直接把原因抛给调用方。
 * 理由是这条路上唯一确定的事就是"提交了也必废" —— 音频驱动模式下, 音频就是片子的全部内容,
 * 拿一段静音去驱动口型, 产出的是**闭着嘴的哑巴视频**, 而阿里云照样按秒收钱。
 * 与其花钱买一条注定要删的片子, 不如当场失败、让人看见。
 */
export class DvhTtsFailedError extends Error {
  /**
   * 8-03: TTS 到底为什么失败(TTSResult.silentReason 原文)。
   * 【为什么必须带】8-03 百炼欠费时 TTS 报的是 Arrearage, 但 TTSService 把异常 catch 成
   *   fellSilent 布尔, 原因蒸发了。失败分类(failure-kind.classifyFailure)要靠它把这条
   *   判成 quota_exceeded(充值后可自动重跑), 而不是笼统的 service_down。
   */
  readonly silentReason?: string;
  constructor(message: string, silentReason?: string) {
    super(message);
    this.name = "DvhTtsFailedError";
    if (silentReason) {
      this.silentReason = silentReason;
      // 挂到 cause 上, extractErrorFields 会顺着错误链一路读下去
      (this as Error & { cause?: unknown }).cause = new Error(silentReason);
    }
  }
}

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
  /**
   * 7-31 **真正发给阿里云**的形象/音色/背景。没有这个字段 = 这条片子根本没提交成功(见 fallbackReason),
   *   所以"没有"本身就是证据 —— 别再拿 templateId 重算一遍冒充"实际用了什么"。
   */
  effective?: DvhEffectiveParams;
  /**
   * 7-31 这条不是真渲染时的原因:
   *   mock_mode         = DVH_REAL_MODE 不是 "true"(整条链路都在放占位样片, 谁选什么都一样)
   *   submit_failed     = 提交前/提交时就失败(形象码无权限、背景图不可达…), 未扣费
   *   query_failed_orphan = 已扣费但拿不到成片(孤儿任务), 见 orphanTaskUuid
   *
   * 注: TTS 失败**不在这里** —— 那条直接抛 DvhTtsFailedError, 压根不产出 ProducedVideo。
   */
  fallbackReason?: "mock_mode" | "submit_failed" | "query_failed_orphan";
  /** 兜底原因的错误摘要(给人看的一句话) */
  fallbackError?: string;
}

/**
 * 8-12 提交成功(=已扣费)但取不回成片。
 *
 * 🔴 **绝不能盲目自动重跑** —— submit 已经按 0.165 元/秒扣过一次，重提交是再付一次钱。
 * 正确动作是凭 `taskUuid` 去阿里云把那条已付费的成片捞回来。
 * 所以这个错误必须把 taskUuid 带出去，deferred 记录里也要留着。
 */
export class DvhOrphanTaskError extends Error {
  readonly taskUuid: string;
  constructor(taskUuid: string, cause: string) {
    super(`DVH_ORPHAN_TASK: 已提交并扣费但取不回成片(task ${taskUuid}) — ${cause}`);
    this.name = "DvhOrphanTaskError";
    this.taskUuid = taskUuid;
  }
}

/** 8-12 提交就没成功(未扣费)。服务恢复后原样重跑即可。 */
export class DvhSubmitFailedError extends Error {
  constructor(cause: string) {
    super(`DVH_SUBMIT_FAILED: ${cause}`);
    this.name = "DvhSubmitFailedError";
  }
}

/**
 * 8-13 背景图分辨率不合规。**内容自身问题**（换张图才行），重跑同一张图必然同样失败 ——
 * 所以刻意不归 service_down，让 deferred 判它 content_error、不进自动重跑。
 */
export class DvhBackgroundInvalidError extends Error {
  constructor(reason: string) {
    super(`DVH_BG_INVALID: ${reason}`);
    this.name = "DvhBackgroundInvalidError";
  }
}

/** 8-12 DVH_REAL_MODE 没开且没显式配置演示素材 —— 配置问题，重跑一万次也一样。 */
export class DvhNotRealModeError extends Error {
  constructor() {
    super(
      "DVH_NOT_REAL_MODE: DVH_REAL_MODE 不是 'true'，且未显式配置 DVH_MOCK_FIXTURE_BASE。" +
        "生产环境必须开 DVH_REAL_MODE；开发/演示环境请显式设置 DVH_MOCK_FIXTURE_BASE 才会返回占位样片。",
    );
    this.name = "DvhNotRealModeError";
  }
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
    // 7-31 🔴 这条分支下"选什么形象/背景/音色都不生效"是必然的 —— 三个参数一个都没往阿里云发,
    //   拿到的是固定占位样片。它以前只是静默返回, 于是从界面上看就像"参数丢了"。现在明写。
    logger.warn(
      { tenantId, templateId, DVH_REAL_MODE: process.env.DVH_REAL_MODE ?? "(未设置)" },
      "dvh.produce.mock_mode — DVH_REAL_MODE 不是 'true', 本条返回占位样片, 形象/背景/音色一律不生效",
    );
    // 7-31 上简报: 生产上误关 DVH_REAL_MODE 的后果是"整天出片、条条是占位样片、界面全显示成功",
    //   靠日志永远发现不了。走**节流版** —— 一旦误关就是每条都命中, 不限速会把 ops_incidents 刷屏
    //   (与 llm_timeout 同一考虑); 这里要的是"有没有发生", 不是"发生了几次"。
    void recordIncidentThrottled(
      {
        kind: "dvh_mock_mode", severity: "warn", tenantId,
        message: `数字人处于演示模式(DVH_REAL_MODE=${process.env.DVH_REAL_MODE ?? "未设置"}), 出的是固定占位样片, 形象/背景/音色一律不生效`,
        detail: { templateId, DVH_REAL_MODE: process.env.DVH_REAL_MODE ?? null },
      },
      { key: "dvh_mock_mode" },
    );
    // 🔴 8-12: 生产链路不再返回占位样片。只有**显式**配置了 DVH_MOCK_FIXTURE_BASE
    //   (= 开发/演示环境的主动选择) 才给占位; 否则当场失败。
    //   老规矩: 一个看起来成功、其实是固定样片的产物, 比一个明确的失败坏得多。
    if (!env.DVH_MOCK_FIXTURE_BASE) throw new DvhNotRealModeError();
    return { ...m, rawVideoUrl: undefined, postprocessed: false, realMode: false, fallbackReason: "mock_mode" };
  }
  // PR #261 (5-29): 防烧钱 — submit 即扣费 (0.165 元/秒). 一旦 query 拿到付费 videoUrl,
  //   之后任何失败都绝不退回 mock, 必须把付费产物落库. taskUuid/rawVideoUrl 提到 try 外保命.
  let taskUuid: string | undefined;
  let rawVideoUrl: string | undefined;
  let durationMs = 0;
  // 7-31 真正发给阿里云的那份参数 — submit 成功才有值, 一路带回给调用方落 metadata
  let effective: DvhEffectiveParams | undefined;
  /**
   * 🔴 8-13 背景图分辨率闸 —— 必须在 submit(=扣费点) 之前。
   *
   * 探针实测: 近 14 天**带背景图的 DVH 任务 5 条全失败、0 条成功**,
   * failCode 一律 10010002「图片分辨率必须与输出的视频分辨率一致」;
   * 不带背景图的 15 条全成功。也就是说这条路径当时的成功率是 **0%**,
   * 而每一条都先扣了钱。上传侧已加归一, 这里兜住 OSS 里已存在的旧图。
   */
  if (backgroundUrl && backgroundUrl !== "none") {
    const { checkBackgroundResolution } = await import("./background-library.js");
    const bad = await checkBackgroundResolution(backgroundUrl);
    if (bad) {
      void recordIncident({
        kind: "dvh_bg_resolution_rejected", severity: "warn", tenantId,
        message: `背景图分辨率不合规, 已在扣费前中止: ${bad.slice(0, 160)}`,
        detail: { backgroundUrl, templateId, title: title.slice(0, 80) },
      });
      throw new DvhBackgroundInvalidError(bad);
    }
  }

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
      // 7-31 🔴 TTS 静音降级闸 —— 必须在 submit(=扣费点) 之前。
      //   TTSService 四个 provider 分支全是"合成失败 → silentMp3() 顶上"; 音频驱动下音频就是片子的
      //   全部内容, 拿静音去驱动口型 = 一条闭着嘴的哑巴视频, 而阿里云照秒收钱。
      //   以前 fellSilent 只进日志, 于是这条链路明知会废还照提交照扣费。现在当场中止。
      if (tts.fellSilent) {
        const reason = `TTS 合成失败降级为静音(provider=${process.env.TTS_PROVIDER ?? "未配置"}), 已中止提交 — 提交了必是哑巴视频且照样扣费`;
        // 8-03: 把 TTS 的**真实失败原因**一路带上(欠费 vs 网络挂 vs 凭证没配, 处置完全不同)
        logger.error(
          { tenantId, templateId, clonedVoiceId, ttsProvider: process.env.TTS_PROVIDER ?? null, silentReason: tts.silentReason ?? null },
          `dvh.tts.silent_abort — ${reason}`,
        );
        void recordIncident({
          kind: "dvh_tts_failed", severity: "error", tenantId,
          message: `${reason}${tts.silentReason ? ` | 原因: ${tts.silentReason.slice(0, 160)}` : ""}`,
          detail: {
            templateId, clonedVoiceId: clonedVoiceId ?? null,
            ttsProvider: process.env.TTS_PROVIDER ?? null, chars: text.length,
            silentReason: tts.silentReason ?? null,
          },
        });
        throw new DvhTtsFailedError(`DVH_TTS_FAILED: ${reason}`, tts.silentReason);
      }
      // 7-31 存证: 音频驱动下音色**真生效**, 记下这条音频是用哪个 voice 合的
      // 阿里云需HTTPS拉音频。OSS私有桶→签名URL(限时有效、不公开); 本地→相对路径转公网base。submit前算好, 不可达直接抛(不白扣费)
      const audioUrl = toPublicUrl(await storage.getSignedUrl(tts.remotePath, 7200));
      const submit = await submitDvhAudioTask({
        audioUrl, templateId, tenantId, title,
        sampleRate: process.env.DVH_AUDIO_SAMPLE_RATE ? parseInt(process.env.DVH_AUDIO_SAMPLE_RATE, 10) : undefined,
        ...(backgroundUrl ? { backgroundUrl } : {}),
        ...(clonedVoiceId ? { ttsVoice: clonedVoiceId } : {}),
      });
      taskUuid = submit.taskUuid;
      effective = submit.effective;
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
      // 7-31 requestedVoiceId 只为存证: 文字驱动这条路音色只认 mapping.voiceCode(见 submit-task 注释),
      //   传进去是为了让日志/metadata 能写出"用户要 X 但实际是 Y", 不是为了让它生效。
      const submit = await submitDvhTask({
        text, templateId, tenantId, title,
        ...(backgroundUrl ? { backgroundUrl } : {}),
        ...(clonedVoiceId ? { requestedVoiceId: clonedVoiceId } : {}),
      });
      taskUuid = submit.taskUuid;
      effective = submit.effective;
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
    return {
      videoUrl: pp.videoUrl, rawVideoUrl, taskUuid, durationMs,
      postprocessed: pp.postprocessed, realMode: true,
      ...(effective ? { effective } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 7-31 TTS 硬失败原样上抛 —— 与 BUDGET_EXCEEDED 同档, **绝不退占位样片**。
    //   放在最前面: 它发生在 submit 之前, 既没扣费也没 taskUuid, 下面几个分支一个都不该沾。
    //   若掉进下面的 mock 兜底, 就又变回"界面显示成功、内容管理里躺着一条假视频"——正是本次要消灭的东西。
    if (err instanceof DvhTtsFailedError) throw err;
    // ★ 已拿到付费视频却抛错 (理论上 postprocess 已兜底, 此为防御): 用原始付费 URL 落库, 绝不退 mock.
    if (rawVideoUrl) {
      logger.error({ err: msg, taskUuid, rawVideoUrl }, "dvh.bridge.kept_paid_video_despite_error");
      return {
        videoUrl: rawVideoUrl, rawVideoUrl, taskUuid: taskUuid!, durationMs,
        postprocessed: false, realMode: true,
        ...(effective ? { effective } : {}),
      };
    }
    // ★ submit 成功 (已扣费) 但 query 失败/超时: 阿里云任务可能仍在跑/已完成. 记 orphanTaskUuid 供后续 recover, 不静默吞.
    if (taskUuid) {
      logger.error({ err: msg, taskUuid }, "dvh.bridge.paid_task_orphaned_query_failed");
      // 7-31 上简报: 这是**钱花了没拿到货**, 四种兜底里最贵的一种, 且 orphanTaskUuid 拿在手上
      //   还能去阿里云捞回成片 —— 只写在日志里等于放弃这笔钱。不节流: 一条 = 一笔损失, 条数就是要看的量。
      void recordIncident({
        kind: "dvh_paid_task_orphaned", severity: "error", tenantId,
        message: `数字人任务已提交并扣费, 但取不回成片(task ${taskUuid}) — 可凭该 taskUuid 去阿里云捞回`,
        detail: { taskUuid, templateId, title: title.slice(0, 80), estimatedCents: estimateDvhCents(text), err: msg.slice(0, 300) },
      });
      // PR-W1: submit 已扣费但拿不到实际时长 — 按预估记账, note 标孤儿供核对
      void recordCost({
        tenantId, kind: "dvh",
        amountCents: estimateDvhCents(text),
        note: `DVH孤儿任务(预估) ${title.slice(0, 50)} (task ${taskUuid})`,
      });
      // 🔴 8-12: 不再退占位样片。8-12 实测线上因此躺着 4 条"状态 draft、看不出异常"的假成品
      //   (标题是真实期刊内容, 片子是固定占位样片, 还带着与该刊无关的 IF/分区大字卡)。
      //   改为抛错 → 调用方落 status=failed + metadata.deferred, 服务恢复后由重跑接管。
      throw new DvhOrphanTaskError(taskUuid, msg);
    }
    // submit 都没成功 — 未扣费, 正常 fallback mock.
    // 7-31 由 warn 升到 error: 真实模式下走到这里, 运营界面上仍然是"生成成功"、内容管理里也真有一条视频,
    //   但那条是**固定占位样片** —— 形象/背景/音色当然全不对(压根没提交)。这正是 7-31 老板实测到的现象,
    //   而 warn 级别在生产日志里几乎不会被人翻到, 于是看起来就成了"参数被吞了"。
    logger.error(
      { err: msg, tenantId, templateId, backgroundUrl, clonedVoiceId },
      "dvh.bridge.real_failed_fallback_mock — 未提交成功, 本条落库的是占位样片, 非真渲染",
    );
    // 7-31 上简报: 没扣费, 但界面显示"生成成功"、内容管理里确实躺着一条视频(占位样片)。
    //   运营会拿它当成品看、当成品发 —— 这比单纯的失败更坏, 必须有人知道。
    void recordIncident({
      kind: "dvh_submit_failed", severity: "error", tenantId,
      message: `数字人视频提交失败(未扣费), 本条落库的是占位样片非真渲染: ${msg.slice(0, 200)}`,
      detail: {
        templateId, title: title.slice(0, 80),
        backgroundUrl: backgroundUrl ?? null, clonedVoiceId: clonedVoiceId ?? null,
        err: msg.slice(0, 300),
      },
    });
    // 🔴 8-12: 同上, 不再退占位样片。未扣费, 服务恢复后原样重跑即可。
    throw new DvhSubmitFailedError(msg);
  }
}
