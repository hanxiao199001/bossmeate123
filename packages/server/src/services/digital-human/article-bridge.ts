/**
 * article → DVH 数字人视频 bridge. PR #57 fire-and-forget 模式复用.
 * 流程: 去重 → 取 article → 抽 narration → real 失败 fallback mock → 持久化 contents (type=video)
 */
import { and, eq, sql } from "drizzle-orm";
import type { db as dbType } from "../../models/db.js";
import { contents, platformAccounts } from "../../models/schema.js";
import { initialStatusFields } from "../articles/state-machine.js";
import { logger } from "../../config/logger.js";
import { resolveAvatarVoice, type TemplateId } from "./template-mapping.js";
// 7-30: produceVideo/toPublicUrl 已搬到 produce-video.ts(与文字稿直生链路共用, 逻辑未改)
import { produceVideo } from "./produce-video.js";

export interface DvhBridgeOptions {
  db: typeof dbType;
  tenantId: string;
  userId: string;
  articleContentId: string;
  templateId: TemplateId | string; // PR-X2: 目录扩展后支持自定义 key
  conversationId?: string | null;
  journalId?: string;
  clonedVoiceId?: string; // 6-26 该账号克隆音色(传给TTS当本人声音)
  /** 7-29 本次生成的背景图公网 URL(系统图库/运营上传); DVH_BG_NONE="none" = 显式黑底 */
  backgroundUrl?: string;
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

// P0-2 防双重扣费: 进程内"在途"锁。单 pm2 实例下, 双击/重试的并发请求会都先过 DB SELECT 去重(还没插入)
// → 各自 produceVideo(扣费)→ 双重扣钱。此 Set 锁住"正在为某文章生成", 第二个并发请求直接跳过。
const inFlightDvh = new Set<string>();

export async function triggerDvhFromArticle(opts: DvhBridgeOptions): Promise<void> {
  const { db, tenantId, userId, articleContentId, templateId, conversationId, journalId, clonedVoiceId, backgroundUrl } = opts;
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
    const produced = await produceVideo({
      text: narration, title, templateId, tenantId,
      ...(voiceForDvh ? { clonedVoiceId: voiceForDvh } : {}),
      ...(backgroundUrl ? { backgroundUrl } : {}),
    });

    const videoMetadata = {
      videoUrl: produced.videoUrl,
      // PR #261: 留存阿里云原始付费 mp4 — 后处理 URL 若失效仍可回退到付费产物.
      rawVideoUrl: produced.rawVideoUrl ?? produced.videoUrl,
      taskUuid: produced.taskUuid,
      // PR #261: 已付费但 query 失败的孤儿任务 — 落到 metadata 供补偿脚本 re-query 找回视频.
      ...(produced.orphanTaskUuid ? { orphanTaskUuid: produced.orphanTaskUuid } : {}),
      durationMs: produced.durationMs,
      postprocessed: produced.postprocessed,
      // 7-31 同 text-bridge: 旧字段改成以**实际生效值**为准, 缺失才回退 mapping(= 没提交成功那种情况)
      avatarCode: produced.effective?.avatarCode ?? mapping.avatarCode,
      avatarLabel: produced.effective?.avatarLabel ?? mapping.avatarLabel,
      voiceCode: produced.effective?.voiceCode ?? mapping.voiceCode,
      voiceLabel: produced.effective?.voiceLabel ?? mapping.voiceLabel,
      templateId,
      // 7-29 存证: 这条视频用的哪张背景图。阿里云可能"接受但静默忽略"(前车之鉴 SubtitleStyle.color),
      //   出片没背景时靠这个字段区分"没传"还是"传了被忽略"。
      ...(backgroundUrl ? { backgroundUrl } : {}),
      // 7-31 "选了什么" vs "实际用了什么" 分开记(与文字稿链路同一套字段, 查证脚本只写一份)
      requested: {
        templateId: String(templateId),
        ...(voiceForDvh ? { voiceId: voiceForDvh } : {}),
        ...(backgroundUrl ? { backgroundUrl } : {}),
      },
      ...(produced.effective ? { effective: produced.effective } : {}),
      ...(produced.fallbackReason ? { fallbackReason: produced.fallbackReason } : {}),
      ...(produced.fallbackError ? { fallbackError: produced.fallbackError.slice(0, 300) } : {}),
      ...(produced.fallbackReason && produced.fallbackReason !== "query_failed_orphan" ? { placeholder: true } : {}),
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

    // 7-31 同 text-bridge: success 只在真拿到阿里云成片时才报。占位兜底另起一条 error,
    //   否则日志里"成功"和"其实是占位样片"长得一模一样, 排查时只能一条条去翻 metadata。
    const logCtx = {
      articleContentId, videoContentId: row?.id, templateId, realMode: produced.realMode, journalId,
      effective: produced.effective, fallbackReason: produced.fallbackReason,
    };
    if (produced.fallbackReason) {
      logger.error(
        { ...logCtx, orphanTaskUuid: produced.orphanTaskUuid, fallbackError: produced.fallbackError },
        "dvh.bridge.placeholder — 落库了, 但这条不是真渲染(见 fallbackReason), 别当成品用",
      );
    } else {
      logger.info(logCtx, "dvh.bridge.success");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, articleContentId, templateId: opts.templateId },
      "dvh.bridge.fatal",
    );
  } finally {
    inFlightDvh.delete(inflightKey);
  }
}
