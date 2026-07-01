/**
 * article → DVH 数字人视频 bridge. PR #57 fire-and-forget 模式复用.
 * 流程: 去重 → 取 article → 抽 narration → real 失败 fallback mock → 持久化 contents (type=video)
 */
import { and, eq, sql } from "drizzle-orm";
import type { db as dbType } from "../../models/db.js";
import { contents, platformAccounts } from "../../models/schema.js";
import { initialStatusFields } from "../articles/state-machine.js";
import { logger } from "../../config/logger.js";
import { isRealMode } from "./client.js";
import { submitDvhTask, submitDvhAudioTask } from "./submit-task.js";
import { buildSrtFromText } from "./subtitle-from-text.js";
import { ttsService } from "../video/tts-service.js";
import { storage } from "../storage/index.js";
import { queryDvhTaskUntilDone } from "./query-task.js";
import { getMockDvhFixture } from "./mock-fixture.js";
import { postprocessVideoWithSubtitle } from "./video-postprocess.js";
import { resolveAvatarVoice, type TemplateId } from "./template-mapping.js";
import { checkBudget, estimateDvhCents, recordCost, DVH_CENTS_PER_SECOND } from "../billing/cost-ledger.js";

export interface DvhBridgeOptions {
  db: typeof dbType;
  tenantId: string;
  userId: string;
  articleContentId: string;
  templateId: TemplateId | string; // PR-X2: 目录扩展后支持自定义 key
  conversationId?: string | null;
  journalId?: string;
  clonedVoiceId?: string; // 6-26 该账号克隆音色(传给TTS当本人声音)
}

/**
 * 6-26 音频驱动修: 阿里云要去公网拉音频/字幕, 但本地存储后端返回相对路径 /storage/...
 *   → 拼成公网绝对 URL。OSS 后端已返回绝对 http(s) 则原样返回。
 *   未配 DVH_PUBLIC_BASE 又是相对路径时抛错 —— 在 submit 之前抛, 避免提交不可达资源 = 白扣费产生孤儿任务。
 */
function toPublicUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = process.env.DVH_PUBLIC_BASE?.replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "DVH_AUDIO_DRIVEN 需要公网可达的音频/字幕 URL, 但本地存储返回相对路径。请设 DVH_PUBLIC_BASE=https://你的域名 (实测 https://boss-mate.cn), 或改用 OSS 存储。",
    );
  }
  return base + (url.startsWith("/") ? url : "/" + url);
}

/**
 * 抽取朗读文本.
 * PR #241 (5-23): 优先 article.metadata.videoScript (AI 专为视频写的脚本, 100-150 字钩子+数据+CTA).
 *   没有 fallback 到 title + body 前 80 字 (V1 简陋兜底).
 */
function extractNarration(article: { title: string | null; body: string | null; metadata: unknown }): string {
  // PR #241 v2: 优先 videoScript (目标 90 秒视频, 250-350 字; 阈值 100 字过滤太短的兜底数据)
  const meta = article.metadata as { videoScript?: string } | null;
  const vs = meta?.videoScript;
  if (typeof vs === "string" && vs.trim().length >= 100) {
    return vs.trim().slice(0, 600);
  }
  // Fallback: 老逻辑 title + body 前 80 字
  const title = article.title ?? "";
  const plain = (article.body || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return `${title}。${plain.slice(0, 80)}。`.slice(0, 200);
}

interface ProducedVideo {
  videoUrl: string;          // 最终落库 URL (后处理成功=新 OSS, 失败=付费原始 URL, mock=占位)
  rawVideoUrl?: string;      // 阿里云原始付费 mp4 (real 成功才有, 留存以防后处理 URL 失效)
  taskUuid: string;
  orphanTaskUuid?: string;   // 已付费但 query 失败/超时的孤儿任务 — 记下供后续 recover
  durationMs: number;
  postprocessed: boolean;
  realMode: boolean;
}

async function produceVideo(text: string, title: string, templateId: TemplateId | string, tenantId: string, clonedVoiceId?: string): Promise<ProducedVideo> {
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
      const submit = await submitDvhTask({ text, templateId, tenantId, title });
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

// P0-2 防双重扣费: 进程内"在途"锁。单 pm2 实例下, 双击/重试的并发请求会都先过 DB SELECT 去重(还没插入)
// → 各自 produceVideo(扣费)→ 双重扣钱。此 Set 锁住"正在为某文章生成", 第二个并发请求直接跳过。
const inFlightDvh = new Set<string>();

export async function triggerDvhFromArticle(opts: DvhBridgeOptions): Promise<void> {
  const { db, tenantId, userId, articleContentId, templateId, conversationId, journalId, clonedVoiceId } = opts;
  const inflightKey = `${tenantId}:${articleContentId}`;
  if (inFlightDvh.has(inflightKey)) {
    logger.info({ articleContentId }, "dvh.bridge.in_flight_skip");
    return;
  }
  inFlightDvh.add(inflightKey);
  try {
    const existing = await db.select({ id: contents.id }).from(contents).where(and(
      eq(contents.tenantId, tenantId),
      eq(contents.type, "video"),
      sql`${contents.metadata}->>'sourceArticleId' = ${articleContentId}`,
      sql`${contents.metadata}->>'source' = 'dvh'`,
    )).limit(1);
    if (existing.length > 0) {
      logger.info({ articleContentId, existingId: existing[0]!.id }, "dvh.bridge.dedup");
      return;
    }
    const [article] = await db.select().from(contents).where(eq(contents.id, articleContentId)).limit(1);
    if (!article) {
      logger.warn({ articleContentId }, "dvh.bridge.no_article");
      return;
    }
    const title = article.title ?? "BossMate";
    // PR #241: extractNarration 改签 — 传 article 让其内部判断 metadata.videoScript 优先
    const narration = extractNarration(article);
    const mapping = (await resolveAvatarVoice(String(templateId))) ?? { avatarCode: "", avatarLabel: "", voiceCode: "", voiceLabel: "", templateLabel: String(templateId) };
    // 6-26 按账号用本人克隆音色: 未显式传则从文章绑定的 exclusiveAccountId 反查(覆盖批量自动路径)
    let voiceForDvh = clonedVoiceId;
    if (!voiceForDvh) {
      const exAcc = (article.metadata as { exclusiveAccountId?: string } | null)?.exclusiveAccountId;
      if (exAcc) {
        try {
          const [acc] = await db.select({ v: platformAccounts.clonedVoiceId }).from(platformAccounts).where(eq(platformAccounts.id, exAcc)).limit(1);
          if (acc?.v) voiceForDvh = acc.v;
        } catch { /* 用默认 */ }
      }
    }
    const produced = await produceVideo(narration, title, templateId, tenantId, voiceForDvh);

    const videoMetadata = {
      videoUrl: produced.videoUrl,
      // PR #261: 留存阿里云原始付费 mp4 — 后处理 URL 若失效仍可回退到付费产物.
      rawVideoUrl: produced.rawVideoUrl ?? produced.videoUrl,
      taskUuid: produced.taskUuid,
      // PR #261: 已付费但 query 失败的孤儿任务 — 落到 metadata 供补偿脚本 re-query 找回视频.
      ...(produced.orphanTaskUuid ? { orphanTaskUuid: produced.orphanTaskUuid } : {}),
      durationMs: produced.durationMs,
      postprocessed: produced.postprocessed,
      avatarCode: mapping.avatarCode,
      avatarLabel: mapping.avatarLabel,
      voiceCode: mapping.voiceCode,
      voiceLabel: mapping.voiceLabel,
      templateId,
      sourceArticleId: articleContentId,
      source: "dvh",
      autoGenerated: true,
      realMode: produced.realMode,
    };

    // PR #261 防烧钱: 付费视频落库失败不可静默丢弃 — 重试 1 次; 仍失败则 ERROR 记 videoUrl+taskUuid 供人工/补偿恢复.
    let row: { id: string } | undefined;
    let insertErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        [row] = await db.insert(contents).values({
          tenantId, userId,
          conversationId: conversationId ?? null,
          type: "video",
          title,
          body: produced.videoUrl,
          ...initialStatusFields("draft"),
          metadata: videoMetadata,
        }).returning({ id: contents.id });
        insertErr = undefined;
        break;
      } catch (e) {
        insertErr = e;
        logger.warn({ attempt, err: e instanceof Error ? e.message : e, articleContentId }, "dvh.bridge.insert_retry");
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (insertErr) {
      // 付费产物未能落库 — 用 ERROR 级别把可恢复信息 (videoUrl/rawVideoUrl/taskUuid) 留在日志, 防止钱白花且无迹可寻.
      logger.error(
        {
          err: insertErr instanceof Error ? insertErr.message : insertErr,
          articleContentId, templateId, journalId,
          realMode: produced.realMode,
          taskUuid: produced.taskUuid,
          videoUrl: produced.videoUrl,
          rawVideoUrl: produced.rawVideoUrl,
        },
        "dvh.bridge.insert_failed_paid_video_recoverable",
      );
      return;
    }

    logger.info(
      { articleContentId, videoContentId: row?.id, templateId, realMode: produced.realMode, journalId },
      "dvh.bridge.success",
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, articleContentId, templateId: opts.templateId },
      "dvh.bridge.fatal",
    );
  } finally {
    inFlightDvh.delete(inflightKey);
  }
}
