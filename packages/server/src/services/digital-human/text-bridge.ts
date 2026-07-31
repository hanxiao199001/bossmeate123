/**
 * 7-30 文字稿直生数字人视频 —— 运营自己写好口播稿, 直接出片, 不经过期刊推荐/文章那条链路。
 *
 * 与 article-bridge 的关系: 合成那一半(produceVideo)完全共用, 这里只负责
 *   "文本从哪来 + 怎么落库 + 怎么防重复扣费"。所以这个文件里**没有一行**期刊/文章的概念。
 *
 * 落库形态与文章链路一致: contents 独立一行 type="video", body=videoUrl
 *   → GET /video/list 按 type='video' 查, 直生视频自动出现, 分发侧零改动。
 *   区别只在 metadata: 不写 sourceArticleId, 改写 sourceType="custom_text" + narrationText(口播稿原文)。
 *
 * 【为什么必须存 narrationText】文章链路的口播稿是从 article.metadata.videoScript 抽的,
 *   事后还能回文章去查; 直生的稿子只存在于运营那一次输入里 —— 不存原文 = 这条视频说了什么
 *   永远只能靠看视频。出了合规问题要溯源时这就是唯一证据。
 */
import { createHash } from "node:crypto";
import type { db as dbType } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { initialStatusFields } from "../articles/state-machine.js";
import { logger } from "../../config/logger.js";
import { resolveAvatarVoice, type TemplateId } from "./template-mapping.js";
import { produceVideo } from "./produce-video.js";

export interface DvhTextBridgeOptions {
  db: typeof dbType;
  tenantId: string;
  userId: string;
  /** 运营手写的口播稿原文(路由层已校过 50~600 字 + 内容安全闸) */
  text: string;
  /** 不传就用口播稿开头当标题 */
  title?: string;
  templateId: TemplateId | string;
  /** 7-10 音色库: 单次生成临时换音色。⚠️ 仅 DVH_AUDIO_DRIVEN=1 时真正生效(见下方落库注释) */
  voiceId?: string;
  /** 背景图公网 URL; "none" = 显式黑底 */
  backgroundUrl?: string;
  conversationId?: string | null;
  /** 前端为"这一次提交意图"生成的幂等键(见文件末尾在途锁一节) */
  idempotencyKey?: string;
  /** 合规软词(不拦截, 落 metadata 供事后审计) */
  complianceSoftHits?: string[];
  /**
   * 路由层已经 acquire 好的在途槽位。传了就由本函数在 finally 里 release ——
   * 之所以让路由先 acquire 而不是本函数自己抢, 是因为 fire-and-forget 的路由必须
   * **同步知道**"这次是重复提交", 才能回 409 给运营看, 而不是回 200 却什么都没发生。
   */
  slotKeys?: string[];
}

// ============ 在途锁(防双击 = 防两份 15 元) ============

/**
 * 🔴 这是整条链路最要命的一道。
 *
 * 文章链路的锁 key 是 `${tenantId}:${articleContentId}` —— 直生根本没有 articleId,
 * 照抄就等于没锁。而 DVH 是 **submit 即扣费**, 运营手一抖双击 = 两条任务 = 两份钱。
 *
 * 双保险两把 key(全有全无地抢, 任一被占就整体失败):
 *   ① 内容指纹 `${tenantId}:txt:${sha1(templateId|voiceId|bg|归一化后的稿子)}`
 *      —— 服务端自己算的, 前端漏传/传错 idempotencyKey 也拦得住。
 *      指纹带上形象/音色/背景: 同一份稿子换个形象再生成一条是**正当需求**, 不能误拦。
 *   ② 客户端幂等键 `${tenantId}:idem:${key}`(传了才有)
 *      —— 覆盖"请求超时前端没收到响应 → 自动/手动重试"这类内容相同但服务端可能已受理的场景。
 *
 * 并发窗口 = 整个生成过程(submit→轮询→后处理, 实测 1~5 分钟), 即"第一条还没出片之前,
 * 同参数的第二次提交一律拒"。出片之后再点就是运营的主动意愿了(比如对第一版不满意想重来),
 * 不该拦 —— 拦了反而要客服解释"为什么点了没反应"。
 *
 * ⚠️ 进程内锁 = 单实例有效。现在是单 pm2 实例(与 article-bridge 的 inFlightDvh 同前提);
 *   将来要多实例, 这里得换 Redis SETNX, 见"已知限制"。
 * TTL 兜底: 万一哪条路径漏了 release(理论上 finally 全覆盖), 20 分钟后自动过期,
 *   免得一个泄漏的 key 把这份稿子永久锁死。
 */
const TEXT_SLOT_TTL_MS = 20 * 60 * 1000;
const inFlightDvhText = new Map<string, number>();

function sweepExpired(now: number): void {
  for (const [k, at] of inFlightDvhText) {
    if (now - at > TEXT_SLOT_TTL_MS) {
      inFlightDvhText.delete(k);
      logger.warn({ slot: k }, "dvh.text.slot_expired_swept — 在途锁超时自动释放, 若频繁出现说明有 release 泄漏");
    }
  }
}

/** 口播稿指纹。归一化(去空白)后再 hash: 只多敲一个空格不算"另一份稿子"。 */
export function narrationFingerprint(text: string): string {
  return createHash("sha1").update(String(text ?? "").replace(/\s+/g, ""), "utf8").digest("hex");
}

/** 算出这次提交要占的槽位(内容指纹 + 可选的客户端幂等键)。 */
export function buildDvhTextSlotKeys(opts: {
  tenantId: string;
  text: string;
  templateId: string;
  voiceId?: string;
  backgroundUrl?: string;
  idempotencyKey?: string;
}): string[] {
  const fp = createHash("sha1")
    .update([opts.templateId, opts.voiceId ?? "", opts.backgroundUrl ?? "", narrationFingerprint(opts.text)].join("|"), "utf8")
    .digest("hex");
  const keys = [`${opts.tenantId}:txt:${fp}`];
  if (opts.idempotencyKey) keys.push(`${opts.tenantId}:idem:${opts.idempotencyKey}`);
  return keys;
}

/** 全有全无地抢槽位。返回 false = 有同参数任务在途, 调用方应回 409。 */
export function acquireDvhTextSlots(keys: string[]): boolean {
  const now = Date.now();
  sweepExpired(now);
  if (keys.some((k) => inFlightDvhText.has(k))) return false;
  for (const k of keys) inFlightDvhText.set(k, now);
  return true;
}

export function releaseDvhTextSlots(keys: string[]): void {
  for (const k of keys) inFlightDvhText.delete(k);
}

/** 测试/排障用: 当前在途槽位数。 */
export function inFlightDvhTextCount(): number {
  return inFlightDvhText.size;
}

// ============ 主流程 ============

export async function triggerDvhFromText(opts: DvhTextBridgeOptions): Promise<void> {
  const {
    db, tenantId, userId, text, templateId, voiceId, backgroundUrl,
    conversationId, idempotencyKey, complianceSoftHits,
  } = opts;

  // 路由层没抢就自己抢(直接调本函数的脚本/测试路径), 抢不到直接走人 —— 绝不能重复扣费。
  const slotKeys = opts.slotKeys ?? buildDvhTextSlotKeys({
    tenantId, text, templateId: String(templateId),
    ...(voiceId ? { voiceId } : {}),
    ...(backgroundUrl ? { backgroundUrl } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if (!opts.slotKeys && !acquireDvhTextSlots(slotKeys)) {
    logger.info({ tenantId, templateId }, "dvh.text.in_flight_skip");
    return;
  }

  // 标题: 没填就拿稿子开头顶上(DVH 那边还会再截到 60 字, 这里先给个人看得懂的)
  const title = (opts.title?.trim() || text.trim().slice(0, 24) || "口播稿视频").slice(0, 60);

  try {
    const mapping = (await resolveAvatarVoice(String(templateId)))
      ?? { avatarCode: "", avatarLabel: "", voiceCode: "", voiceLabel: "", templateLabel: String(templateId) };

    const produced = await produceVideo({
      text, title, templateId, tenantId,
      ...(voiceId ? { clonedVoiceId: voiceId } : {}),
      ...(backgroundUrl ? { backgroundUrl } : {}),
    });

    const videoMetadata = {
      videoUrl: produced.videoUrl,
      // PR #261: 留存阿里云原始付费 mp4 — 后处理 URL 若失效仍可回退到付费产物.
      rawVideoUrl: produced.rawVideoUrl ?? produced.videoUrl,
      taskUuid: produced.taskUuid,
      ...(produced.orphanTaskUuid ? { orphanTaskUuid: produced.orphanTaskUuid } : {}),
      durationMs: produced.durationMs,
      postprocessed: produced.postprocessed,
      // ↓ 旧字段(下游/存量数据在用)保留, 但**改成以实际生效值为准**: 之前这里填的是
      //   resolveAvatarVoice(templateId) 重算的"本该用什么", 兜底走占位样片时它照样是一份漂亮数据,
      //   查证时看到"参数都对"却对不上片子 —— 7-31 排查绕圈子就是绕在这。
      avatarCode: produced.effective?.avatarCode ?? mapping.avatarCode,
      avatarLabel: produced.effective?.avatarLabel ?? mapping.avatarLabel,
      voiceCode: produced.effective?.voiceCode ?? mapping.voiceCode,
      voiceLabel: produced.effective?.voiceLabel ?? mapping.voiceLabel,
      // ⚠️ voiceOverride ≠ 一定生效: 文字驱动(默认)走 submitDvhTask, 音色只认 mapping.voiceCode;
      //   只有 DVH_AUDIO_DRIVEN=1 走 TTS 合成音频时 voiceId 才真正换声。与文章链路同一限制,
      //   落库记下来是为了事后能对上"这条为什么不是我选的声音"。
      ...(voiceId ? { voiceOverride: voiceId } : {}),
      templateId,
      ...(backgroundUrl ? { backgroundUrl } : {}),
      // 7-31 🔴 "用户选了什么" 与 "实际用了什么" 分开记 —— 只有一份就永远查不清是哪一层丢的。
      requested: {
        templateId: String(templateId),
        ...(voiceId ? { voiceId } : {}),
        ...(backgroundUrl ? { backgroundUrl } : {}),
      },
      // effective 缺失 = 这条根本没提交到阿里云(见 fallbackReason), 那"参数不生效"就不是参数丢了
      ...(produced.effective ? { effective: produced.effective } : {}),
      ...(produced.fallbackReason ? { fallbackReason: produced.fallbackReason } : {}),
      ...(produced.fallbackError ? { fallbackError: produced.fallbackError.slice(0, 300) } : {}),
      // placeholder=true → 这条不是真渲染, 是占位样片; 别拿它去发布, 也别拿它评估形象/背景效果
      ...(produced.fallbackReason && produced.fallbackReason !== "query_failed_orphan" ? { placeholder: true } : {}),
      source: "dvh",
      // ↓ 直生专属三件: 没有 sourceArticleId, 靠这三个字段自证身世
      sourceType: "custom_text",
      narrationText: text,                              // 口播稿原文(唯一存档)
      narrationHash: narrationFingerprint(text),        // 指纹, 供事后查重/对账
      narrationChars: text.length,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(complianceSoftHits?.length ? { complianceSoftHits } : {}),
      // 文章链路是 AI 自动写的稿 → autoGenerated: true; 手写稿写 true 是错的, 会污染
      // "AI 生成内容占比" 这类统计, 也会让 AI 标识逻辑判断失据。
      autoGenerated: false,
      realMode: produced.realMode,
    };

    // PR #261 防烧钱(原样保留, 一行不省): 付费视频落库失败不可静默丢弃 —
    //   重试 1 次; 仍失败则 ERROR 记 videoUrl+taskUuid 供人工/补偿恢复.
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
        logger.warn({ attempt, err: e instanceof Error ? e.message : e, tenantId }, "dvh.text.insert_retry");
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (insertErr) {
      // 付费产物未能落库 — ERROR 级别把可恢复信息 (videoUrl/rawVideoUrl/taskUuid) + 口播稿留在日志。
      //   直生比文章链路更需要带上 narrationText: 没有文章行可以回溯, 日志是唯一的稿子副本。
      logger.error(
        {
          err: insertErr instanceof Error ? insertErr.message : insertErr,
          tenantId, templateId,
          realMode: produced.realMode,
          taskUuid: produced.taskUuid,
          videoUrl: produced.videoUrl,
          rawVideoUrl: produced.rawVideoUrl,
          narrationText: text,
        },
        "dvh.text.insert_failed_paid_video_recoverable",
      );
      return;
    }

    // 7-31 🔴 success 只在**真拿到阿里云成片**时才报。
    //   以前无论真渲染还是占位兜底都打同一条 dvh.text.success, 于是日志里满屏"成功"、
    //   界面上也一路绿灯, 唯一的差别是个没人注意的 realMode 字段 —— 等于没有信号。
    //   fallbackReason 存在 = 这条不是真渲染(占位样片/孤儿任务), 一律不许叫 success。
    const logCtx = {
      videoContentId: row?.id, templateId, chars: text.length, realMode: produced.realMode,
      // 出片后再打一次"实际生效值" — 与 submit 前那条 dvh.submit.params 对照即可定位丢参数的层
      requestedVoiceId: voiceId, requestedBackgroundUrl: backgroundUrl,
      effective: produced.effective, fallbackReason: produced.fallbackReason,
    };
    if (produced.fallbackReason) {
      logger.error(
        { ...logCtx, orphanTaskUuid: produced.orphanTaskUuid, fallbackError: produced.fallbackError },
        "dvh.text.placeholder — 落库了, 但这条不是真渲染(见 fallbackReason), 别当成品用",
      );
    } else {
      logger.info(logCtx, "dvh.text.success");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, tenantId, templateId },
      "dvh.text.fatal",
    );
  } finally {
    releaseDvhTextSlots(slotKeys);
  }
}
