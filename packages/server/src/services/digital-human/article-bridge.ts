/**
 * article → DVH 数字人视频 bridge. PR #57 fire-and-forget 模式复用.
 * 流程: 去重 → 取 article → 抽 narration → real 失败 fallback mock → 持久化 contents (type=video)
 */
import { and, eq, sql } from "drizzle-orm";
import type { db as dbType } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { initialStatusFields } from "../articles/state-machine.js";
import { logger } from "../../config/logger.js";
import { isRealMode } from "./client.js";
import { submitDvhTask } from "./submit-task.js";
import { queryDvhTaskUntilDone } from "./query-task.js";
import { getMockDvhFixture } from "./mock-fixture.js";
import { postprocessVideoWithSubtitle } from "./video-postprocess.js";
import { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId } from "./template-mapping.js";

export interface DvhBridgeOptions {
  db: typeof dbType;
  tenantId: string;
  userId: string;
  articleContentId: string;
  templateId: TemplateId;
  conversationId?: string | null;
  journalId?: string;
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

async function produceVideo(text: string, title: string, templateId: TemplateId, tenantId: string): Promise<ProducedVideo> {
  if (!isRealMode()) {
    const m = getMockDvhFixture(templateId);
    return { ...m, rawVideoUrl: undefined, postprocessed: false, realMode: false };
  }
  // PR #261 (5-29): 防烧钱 — submit 即扣费 (0.165 元/秒). 一旦 query 拿到付费 videoUrl,
  //   之后任何失败都绝不退回 mock, 必须把付费产物落库. taskUuid/rawVideoUrl 提到 try 外保命.
  let taskUuid: string | undefined;
  let rawVideoUrl: string | undefined;
  let durationMs = 0;
  try {
    const submit = await submitDvhTask({ text, templateId, tenantId, title });
    taskUuid = submit.taskUuid;
    const query = await queryDvhTaskUntilDone(taskUuid);
    rawVideoUrl = query.videoUrl;   // ★ 付费产物到手 — 此后不可丢
    durationMs = query.durationMs;
    // PR #252: ffmpeg burn-in 自定义字幕. postprocess 内部已 fallback 原 videoUrl, 正常不抛.
    const pp = await postprocessVideoWithSubtitle({
      videoUrl: rawVideoUrl,
      subtitlesUrl: query.subtitlesUrl ?? "",
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
      const m = getMockDvhFixture(templateId);
      return { ...m, rawVideoUrl: undefined, orphanTaskUuid: taskUuid, postprocessed: false, realMode: false };
    }
    // submit 都没成功 — 未扣费, 正常 fallback mock.
    logger.warn({ err: msg, templateId }, "dvh.bridge.real_failed_fallback_mock");
    const m = getMockDvhFixture(templateId);
    return { ...m, rawVideoUrl: undefined, postprocessed: false, realMode: false };
  }
}

export async function triggerDvhFromArticle(opts: DvhBridgeOptions): Promise<void> {
  const { db, tenantId, userId, articleContentId, templateId, conversationId, journalId } = opts;
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
    const mapping = TEMPLATE_AVATAR_VOICE_MAP[templateId];
    const produced = await produceVideo(narration, title, templateId, tenantId);

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
  }
}
