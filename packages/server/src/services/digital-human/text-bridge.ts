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
  /**
   * 8-03: 这次是"服务恢复后的自动重跑"的第几次(由 service-health-probe 传入)。
   * 不传 = 运营手动发起的首次生成。重跑再失败时要把计数带下去, 否则 retryCount 永远从 0 开始,
   * DEFERRED_MAX_RETRY 上限形同虚设 —— 一条永远坏的稿子会每 30 分钟烧一次钱。
   */
  deferredRetryCount?: number;
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
    conversationId, idempotencyKey, complianceSoftHits, deferredRetryCount,
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

  /**
   * 8-03 存档动作**放到锁外面做**(见 finally 之后那一段)。
   *
   * 在途锁的职责只有一个: 在"这条稿子正在花钱生产"期间挡住重复提交。
   * 生产一旦结束(不管成没成), 锁就该还回去 —— 后面写失败记录/打 deferred 标记这些
   * 纯存档动作再慢也不该占着它。占着的后果是: 运营眼看着失败了想立刻重来, 却收到 409
   * "有同参数任务在途", 完全说不通。
   */
  let fatalErr: unknown = null;
  let submitFailedContentId: string | null = null;
  let submitFailedError = "";

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
      // 8-03: submit 失败(未扣费)常常就是欠费的下游表现 —— 阿里云同一个账户,
      //   百炼欠费时 DVH 提交也会被拒。给这条占位行打上 deferred, 服务恢复后自动重跑,
      //   而不是留一条"看起来成功、其实是占位样片"的死片子等人去发现。
      //   mock_mode 不打: 那是 DVH_REAL_MODE 没开(配置问题), 重跑一万次还是占位样片。
      if (produced.fallbackReason === "submit_failed" && row?.id) {
        submitFailedContentId = row.id;
        submitFailedError = produced.fallbackError ?? "DVH 提交失败";
      }
    } else {
      logger.info(logCtx, "dvh.text.success");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, tenantId, templateId },
      "dvh.text.fatal",
    );
    fatalErr = err;
  } finally {
    releaseDvhTextSlots(slotKeys);
  }

  // ---- 锁已归还, 下面是存档收尾(不涉及扣费, 慢一点没关系) ----

  // 8-03 🔴 这里就是老板那条 157 字口播稿蒸发的地方。
  //   原来 catch 只打一行 warn 就走人: 不落库、不产视频、界面上什么都没有,
  //   运营既不知道失败了、也拿不回原稿(narrationText 只存在成功路径的 metadata 里)。
  //   现在无论哪类失败都落一条 contents(status=failed, body=口播稿原文),
  //   外部服务类失败再额外挂 metadata.deferred, 服务恢复后自动重跑。
  if (fatalErr !== null) {
    await recordDvhTextFailure(opts, fatalErr, title);
    return;
  }
  // 8-03: submit 失败(未扣费)常常就是欠费的下游表现 —— 阿里云同一个账户,
  //   百炼欠费时 DVH 提交也会被拒。给这条占位行打上 deferred, 服务恢复后自动重跑,
  //   而不是留一条"看起来成功、其实是占位样片"的死片子等人去发现。
  //   mock_mode 不打: 那是 DVH_REAL_MODE 没开(配置问题), 重跑一万次还是占位样片。
  if (submitFailedContentId) {
    await markDvhDeferred({
      contentId: submitFailedContentId,
      err: new Error(submitFailedError),
      opts, retryCount: deferredRetryCount ?? 0,
      detail: "数字人视频提交失败(未扣费)",
    });
  }
}

// ============ 8-03 失败也要留下痕迹(deferred) ============

/** 从一次直生请求还原出"重跑需要的全部输入" —— 少一个字段这条就永远跑不回来了 */
function buildDvhDeferredInput(opts: DvhTextBridgeOptions): import("../ops/deferred.js").DeferredInputDvhText {
  return {
    kind: "dvh_text",
    tenantId: opts.tenantId,
    userId: opts.userId,
    text: opts.text,                       // 🔴 口播稿原文, 唯一副本
    ...(opts.title ? { title: opts.title } : {}),
    templateId: String(opts.templateId),
    ...(opts.voiceId ? { voiceId: opts.voiceId } : {}),
    ...(opts.backgroundUrl ? { backgroundUrl: opts.backgroundUrl } : {}),
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
  };
}

/** 给一条已落库的内容补 deferred 标记(submit 失败的占位行走这条) */
async function markDvhDeferred(args: {
  contentId: string;
  err: unknown;
  opts: DvhTextBridgeOptions;
  retryCount: number;
  detail: string;
}): Promise<void> {
  try {
    const { buildDeferred, markContentDeferred } = await import("../ops/deferred.js");
    const mark = buildDeferred({
      err: args.err,
      input: buildDvhDeferredInput(args.opts),
      detail: args.detail,
      retryCount: args.retryCount,
    });
    if (!mark) return; // content_error → 判死, 不假装能救回来
    await markContentDeferred(args.contentId, mark);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : e }, "dvh.text.mark_deferred_failed");
  }
}

/**
 * 直生彻底失败 → 落一条 status=failed 的 contents, 把口播稿原文放进 body。
 *
 * 【为什么 body 放原稿而不是留空】运营在内容列表点开就能看到自己写了什么、能复制走,
 *   不必去翻服务器日志。这是"稿子还在"这句承诺的实体。
 * 【为什么 content_error 也落库】失败必须可见。区别只在有没有 deferred 块:
 *   有 = 列表显示"待重试"(会自动重跑); 没有 = 显示"失败"(要人处理)。
 */
async function recordDvhTextFailure(opts: DvhTextBridgeOptions, err: unknown, title: string): Promise<void> {
  try {
    const { buildDeferred, insertDeferredContent, describeFailureDetail } = await import("../ops/deferred.js");
    const mark = buildDeferred({
      err,
      input: buildDvhDeferredInput(opts),
      detail: describeFailureDetail(err),
      retryCount: opts.deferredRetryCount ?? 0,
    });
    const contentId = await insertDeferredContent({
      tenantId: opts.tenantId,
      userId: opts.userId,
      type: "video",
      title,
      body: opts.text,                       // 🔴 原稿存这里, 运营看得见、拷得走
      conversationId: opts.conversationId ?? null,
      mark,
      err,
      extraMetadata: {
        source: "dvh",
        sourceType: "custom_text",
        narrationText: opts.text,
        narrationHash: narrationFingerprint(opts.text),
        narrationChars: opts.text.length,
        templateId: String(opts.templateId),
        ...(opts.voiceId ? { voiceOverride: opts.voiceId } : {}),
        ...(opts.backgroundUrl ? { backgroundUrl: opts.backgroundUrl } : {}),
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        ...(opts.complianceSoftHits?.length ? { complianceSoftHits: opts.complianceSoftHits } : {}),
        autoGenerated: false,
        failedStage: "dvh_text_produce",
      },
    });
    logger.error(
      {
        tenantId: opts.tenantId, templateId: opts.templateId, contentId,
        deferredReason: mark?.reason ?? null,
        chars: opts.text.length,
        // 落库失败时(contentId=null)这行日志就是原稿的最后一份副本
        narrationText: contentId ? undefined : opts.text,
      },
      mark
        ? "dvh.text.deferred — 外部服务不可用, 已落库保存原稿, 服务恢复后自动重跑"
        : "dvh.text.failed_recorded — 已落库(内容自身问题, 不自动重跑)",
    );
    if (mark) {
      const { recordIncident } = await import("../ops/incidents.js");
      void recordIncident({
        kind: "content_deferred", severity: "warn", tenantId: opts.tenantId,
        message: `文字稿直生失败已暂停待重跑: 《${title.slice(0, 30)}》 — ${mark.detail}`,
        detail: { contentId, reason: mark.reason, inputKind: "dvh_text", chars: opts.text.length, retryCount: mark.retryCount },
      });
    }
  } catch (e) {
    // 兜底的兜底: 连失败记录都落不下 —— 原稿只剩这条日志
    logger.error(
      { err: e instanceof Error ? e.message : e, tenantId: opts.tenantId, narrationText: opts.text },
      "dvh.text.failure_record_failed — 失败记录未能落库, 口播稿只剩本条日志",
    );
  }
}
