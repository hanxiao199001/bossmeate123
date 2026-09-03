/**
 * 8-03 deferred 标记 —— "这条内容没毛病, 是外部服务当时不可用, 原始输入我给你留着"。
 *
 * 【事故】8-03 老板在"文字稿直生"写了 157 字口播稿点生成 → 百炼欠费 → TTS 失败硬中止
 *   (7-31 那道闸是对的, 提交了必是哑巴视频还照样扣钱) → 但**不落库不产视频**,
 *   稿子直接丢了, 界面上什么都没有。老板得重新写一遍。
 *   同一天质检主备模型同时失败(共用一个阿里云账户), 9 篇内容判 needs_review 卡住,
 *   充完值也没人知道要去重跑 —— 而运营不会做这个。
 *
 * 【为什么不加新的 status 值】
 *   加 "deferred" 状态要动 ALLOWED_TRANSITIONS(status-vocabulary.ts)、前端三张词表、
 *   跨端一致性守卫、draft-distributor 的一堆判据…… 影响面远大于收益。
 *   状态照旧是 failed / needs_review(现有语义都对), 只在 metadata 里加一个 deferred 块:
 *     metadata.deferred = { reason, detail, failedAt, retryCount, input }
 *   现有查询/前端不认识它 = 行为零变化; 认识它的地方(内容列表徽章、探测器、简报)才多做事。
 *
 * 【input 是本模块的核心, 不是附赠品】
 *   没有 input 就没有"自动重跑" —— 老板那条 157 字口播稿现在就是丢了, 想跑也跑不了。
 *   所以每条链路存什么必须写死成类型(见下面几个 DeferredInput*), 少一个字段 TS 就编译不过,
 *   而不是靠"记得存"。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { classifyFailure, extractErrorFields, FAILURE_KIND_LABEL, type FailureKind } from "./failure-kind.js";

// ============ 类型 ============

/** 只有这两类会被 defer —— content_error 判死(重跑也没用), 见 failure-kind.ts */
export type DeferredReason = Exclude<FailureKind, "content_error">;

/**
 * 自动重跑次数上限。
 *
 * 【为什么必须有】探测器每 30 分钟跑一次, 一条**永远坏**的内容(比如稿子里有个必然触发
 *   内容安全拦截的词, 却被误判成 service_down)会每 30 分钟烧一次 LLM/DVH 的钱, 一天 48 次,
 *   还没人发现。超过上限 → 落 deferred_retry_exhausted + 标 exhausted, 从此转人工, 不再自动跑。
 */
export const DEFERRED_MAX_RETRY = 5;

/**
 * 🔴 9-04 件 1(b): deferred 超过这个时长就作废, 不再重跑。
 *
 * 病历(8-31 → 9-03): 欠费 → 370 篇失败挂 deferred → 充值 → 积压全部涌入队列,
 * 和当天新内容叠加 → 一天烧掉 ¥162/¥166(正常日 ¥15-25) → 又欠费 → 积压更大。
 * **每充一次钱, 钱先被旧积压吃掉, 新内容顺延到次日; 次日又是积压优先。**
 *
 * 为什么是 72 小时: 每天都有新选题产出, 4 天前那篇没生成出来的稿子,
 * 不值得再花钱补 —— 它的时效性已经过了, 而补它要挤掉今天的新内容。
 *
 * ⚠️ 这不是"重做存量"(红线 #21 禁止的那件事), 是**放弃从未存在过的东西**:
 * 那些 content 行 body 是 NULL, 从来没有产出过内容, 不存在"已发出去要不要改"的问题。
 *
 * 🔴 不许静默删: 到期只标记 + 落 incident(deferred_expired), 行还在库里。
 * 静默删会让"积压去哪了"变成无法回答的问题 —— 而那正是件 1 要量的东西。
 */
export const DEFERRED_EXPIRE_HOURS = 72;

/** 文章生成(batch-worker 链路)重跑要的全部输入 */
export interface DeferredInputArticle {
  kind: "article_generation";
  /** 重新入队就靠这两个 id —— batch_rows 里存着 topic/template/journalId 的权威副本 */
  batchId: string;
  batchRowId: string;
  tenantId: string;
  userId: string;
  /** 下面几个是"就算 batch_rows 被清了也还原得出这一篇"的冗余快照 */
  topic: string;
  template?: string | null;
  journalId?: string | null;
  accountId?: string | null;
}

/** 文字稿直生 / DVH 视频重跑要的全部输入(老板那条 157 字口播稿就是这里救的) */
export interface DeferredInputDvhText {
  kind: "dvh_text";
  tenantId: string;
  userId: string;
  /** 🔴 口播稿原文 —— 只存在于运营那一次输入里, 不存 = 永久丢失 */
  text: string;
  title?: string;
  templateId: string;
  voiceId?: string;
  backgroundUrl?: string;
  conversationId?: string | null;
}

/** 六维质检重跑: 正文已落库, 有 contentId 就够 */
export interface DeferredInputQualityCheck {
  kind: "quality_check";
  tenantId: string;
  contentId: string;
  journalId?: string | null;
}

export type DeferredInput = DeferredInputArticle | DeferredInputDvhText | DeferredInputQualityCheck;

/** 落在 contents.metadata.deferred 里的那个块 */
export interface DeferredMark {
  reason: DeferredReason;
  /** 给运营看的一句人话, 如"阿里云百炼账户欠费" */
  detail: string;
  failedAt: string;
  retryCount: number;
  input: DeferredInput;
  /** 原始错误摘要(排障用, 不给运营看) */
  lastError?: string;
  lastRetryAt?: string;
  /** 9-04 件 1(b): 超 72 小时已作废, 不再自动重跑。行仍在库里, 只是不再花钱补 */
  expired?: boolean;
  expiredAt?: string;
  /**
   * 已重新入队/已重跑过一轮的时点。**一次 defer 只重跑一次**:
   * article / dvh 两条链路重跑会产出**新的 contents 行**, 老行若不封口, 下一轮探测会再跑一次,
   * 一条稿子生出一堆重复视频(还是付费的)。质检链路是原地重跑, 不设这个字段。
   */
  requeuedAt?: string;
  /** 重跑次数用尽 → 转人工, 探测器从此跳过它 */
  /**
   * true = 不再自动重跑，转人工。两种来源：
   *   ① 自动重试到上限（原设计）
   *   ② 🔴 **重跑本身有副作用、不能盲跑**（8-12 新增场景）——
   *      DVH 孤儿任务已按 0.165 元/秒扣过费，重提交是**再付一次钱**；
   *      正确动作是凭 taskUuid 去阿里云捞回那条已付费的成片。
   *      在「重跑优先 re-query」做出来之前，这类一律出生即 exhausted。
   */
  exhausted?: boolean;
}

// ============ 纯函数(可直接单测, 不碰 DB) ============

const REASON_DETAIL: Record<DeferredReason, string> = {
  quota_exceeded: "AI 账户欠费/额度用尽(充值后自动重跑)",
  service_down: "外部服务当时不可用(服务恢复后自动重跑)",
};

/**
 * 把一次失败 + 这条内容的原始输入, 打成一个 deferred 标记。
 *
 * @returns null = 这次失败是 content_error(内容自己的问题), **不该** defer。
 *   调用方拿到 null 就走原来的失败路径 —— 判死比假装能救回来诚实。
 */
/**
 * 出生即 exhausted 的判据：重跑有副作用、不能盲跑。
 * 现在只有 DVH 孤儿任务一种（已扣费）。加第二种之前先想清楚"重跑一次的代价是什么"。
 */
function bornExhausted(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "DvhOrphanTaskError" || String((err as Error)?.message ?? "").includes("DVH_ORPHAN_TASK");
}

export function buildDeferred(opts: {
  err: unknown;
  input: DeferredInput;
  /** 覆盖默认话术(如 DVH 想说"配音服务失败") */
  detail?: string;
  /** 上一轮的重试次数(重跑失败时把计数带过来, 否则永远从 0 开始 = 无限重试) */
  retryCount?: number;
  now?: Date;
}): DeferredMark | null {
  const kind = classifyFailure(opts.err);
  if (kind === "content_error") return null;
  const f = extractErrorFields(opts.err);
  const mark: DeferredMark = {
    reason: kind,
    detail: opts.detail ?? REASON_DETAIL[kind],
    failedAt: (opts.now ?? new Date()).toISOString(),
    retryCount: Math.max(0, opts.retryCount ?? 0),
    input: opts.input,
  };
  const errText = f.text.trim();
  if (errText) mark.lastError = errText.slice(0, 500);
  // 🔴 重跑有副作用的一类，出生即转人工 —— 见 bornExhausted 与 DeferredMark.exhausted 注释
  if (bornExhausted(opts.err)) mark.exhausted = true;
  return mark;
}

/** 从 metadata 里读出 deferred 块。形状不对一律当没有(绝不抛)。 */
export function readDeferred(metadata: unknown): DeferredMark | null {
  if (!metadata || typeof metadata !== "object") return null;
  const d = (metadata as Record<string, unknown>).deferred;
  if (!d || typeof d !== "object") return null;
  const m = d as Record<string, unknown>;
  if (m.reason !== "quota_exceeded" && m.reason !== "service_down") return null;
  return {
    reason: m.reason,
    detail: typeof m.detail === "string" ? m.detail : REASON_DETAIL[m.reason],
    failedAt: typeof m.failedAt === "string" ? m.failedAt : "",
    retryCount: Number.isFinite(Number(m.retryCount)) ? Number(m.retryCount) : 0,
    input: m.input as DeferredInput,
    ...(typeof m.lastError === "string" ? { lastError: m.lastError } : {}),
    ...(typeof m.lastRetryAt === "string" ? { lastRetryAt: m.lastRetryAt } : {}),
    ...(typeof m.requeuedAt === "string" ? { requeuedAt: m.requeuedAt } : {}),
    ...(m.exhausted === true ? { exhausted: true } : {}),
    ...(m.expired === true ? { expired: true } : {}),
    ...(typeof m.expiredAt === "string" ? { expiredAt: m.expiredAt } : {}),
  };
}

/** 这条 deferred 是否已超过 72 小时(件 1 b)。failedAt 不可解析时**按未过期处理** —— 宁可多跑一次也不误废 */
export function isDeferredExpired(mark: DeferredMark | null, now: Date = new Date()): boolean {
  if (!mark?.failedAt) return false;
  const at = new Date(mark.failedAt);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() > DEFERRED_EXPIRE_HOURS * 3600_000;
}

/** 这条 deferred 现在还能不能自动重跑 */
export function canAutoRetry(mark: DeferredMark | null, now: Date = new Date()): boolean {
  if (!mark) return false;
  if (mark.exhausted) return false;
  if (mark.expired) return false;                  // 9-04 件 1(b): 已作废
  if (isDeferredExpired(mark, now)) return false;  // 超 72h — 即使还没被标记也不再跑
  if (mark.requeuedAt) return false;               // 已经重跑过一轮, 结果由新行承接
  if (!mark.input || typeof mark.input !== "object") return false; // 没有 input = 跑不了
  return mark.retryCount < DEFERRED_MAX_RETRY;
}

/** 给运营看的一句话(内容列表 tooltip / 简报都念这个) */
export function describeDeferred(mark: DeferredMark): string {
  if (mark.exhausted) {
    return `${mark.detail} — 已自动重试 ${mark.retryCount} 次仍失败, 需人工处理`;
  }
  const n = mark.retryCount > 0 ? `(已自动重试 ${mark.retryCount} 次) ` : "";
  return `${mark.detail} ${n}原稿已保存, 服务恢复后会自动重跑`.trim();
}

/** 分类标签直通(前端/简报共用一张表) */
export { FAILURE_KIND_LABEL };

/**
 * 一次失败的"一句人话"。落库进 metadata.deferred.detail / errorMessage, 运营直接看这句。
 * 尽量说具体: 认得出是欠费就说欠费, 说不出就退回三分类的通用说法。
 */
export function describeFailureDetail(err: unknown): string {
  const kind = classifyFailure(err);
  if (kind === "quota_exceeded") {
    const f = extractErrorFields(err);
    const t = `${f.errorType ?? ""} ${f.text}`.toLowerCase();
    if (t.includes("arrearage") || t.includes("arrears") || t.includes("欠费") || t.includes("good standing")) {
      return "AI 服务账户欠费(阿里云百炼/DeepSeek), 充值后自动重跑";
    }
    if (t.includes("budget_exceeded") || t.includes("日上限") || t.includes("llm_daily_cap")) {
      return "已触发花费上限熔断, 额度恢复后自动重跑";
    }
    return REASON_DETAIL.quota_exceeded;
  }
  if (kind === "service_down") {
    const f = extractErrorFields(err);
    if (f.name === "DvhTtsFailedError") return "配音(TTS)服务当时不可用, 恢复后自动重跑";
    if (isTimeoutLike(f.text)) return "AI 服务超时无响应, 恢复后自动重跑";
    return REASON_DETAIL.service_down;
  }
  return FAILURE_KIND_LABEL.content_error;
}

function isTimeoutLike(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("timeout") || t.includes("timed out") || t.includes("abort") || t.includes("超时");
}

// ============ DB 侧(全部 fail-safe: 告警/存档链路绝不反过来把业务搞挂) ============

/** 把 deferred 块合并进某条已存在内容的 metadata */
export async function markContentDeferred(contentId: string, mark: DeferredMark): Promise<boolean> {
  try {
    await db
      .update(contents)
      .set({
        metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify({ deferred: mark })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(contents.id, contentId));
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, contentId }, "deferred.mark_failed — 标记失败, 这条内容将无法自动重跑");
    return false;
  }
}

/**
 * 失败也要落一条 contents 记录。
 *
 * 【为什么】8-03 老板那条口播稿失败后**界面上什么都没有** —— 运营既不知道失败了、
 *   也不知道为什么、更拿不回原稿。石沉大海是最坏的失败形态: 它连"有事发生过"都不留下。
 *   现在落 status=failed + metadata.deferred, 内容列表里看得见"待重试 + 原因 + 原稿还在"。
 *
 * @returns 新行 id; 落库都失败了就返回 null(此时错误信息已进 ERROR 日志, 那是最后兜底)
 */
export async function insertDeferredContent(opts: {
  tenantId: string;
  userId: string;
  type: "article" | "video" | "video_script";
  title: string;
  /** 失败时通常没有正文; DVH 直生就把口播稿放这, 运营能直接看到原稿 */
  body?: string | null;
  conversationId?: string | null;
  /**
   * null = 这次是 content_error(内容自身问题), **照样落库**, 只是不挂 deferred 块。
   * 失败必须可见; 区别只在列表上显示"待重试"还是"失败"。
   */
  mark: DeferredMark | null;
  /** mark 为 null 时用它生成 errorMessage */
  err?: unknown;
  extraMetadata?: Record<string, unknown>;
}): Promise<string | null> {
  const errMsg = opts.mark
    ? (opts.mark.lastError ?? opts.mark.detail)
    : (opts.err instanceof Error ? opts.err.message : String(opts.err ?? "生成失败"));
  try {
    const [row] = await db
      .insert(contents)
      .values({
        tenantId: opts.tenantId,
        userId: opts.userId,
        conversationId: opts.conversationId ?? null,
        type: opts.type,
        title: opts.title.slice(0, 300),
        body: opts.body ?? null,
        // 状态机不变: failed 是既有状态, 且 failed → generating 本来就合法(重跑走这条边)
        status: "failed",
        statusUpdatedAt: new Date(),
        errorMessage: errMsg.slice(0, 500),
        metadata: { ...(opts.extraMetadata ?? {}), ...(opts.mark ? { deferred: opts.mark } : {}) },
      })
      .returning({ id: contents.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : err,
        tenantId: opts.tenantId,
        title: opts.title,
        // 🔴 落库都失败了 —— 日志是原始输入的最后一份副本
        input: opts.mark?.input ?? null,
      },
      "deferred.insert_failed — 失败记录都没落上, 原始输入只剩本条日志",
    );
    return null;
  }
}

export interface DeferredRow {
  id: string;
  tenantId: string;
  userId: string;
  title: string | null;
  status: string;
  mark: DeferredMark;
}

/** SQL 片段: metadata 里有可自动重跑的 deferred 块 */
const RETRIABLE_DEFERRED = sql`
  ${contents.metadata} -> 'deferred' IS NOT NULL
  AND COALESCE(${contents.metadata} -> 'deferred' ->> 'exhausted', 'false') <> 'true'
  -- 9-04 件 1(b): 已作废的不再捞。SQL 层也挡一道 —— 只靠 JS 里的 canAutoRetry 的话,
  -- 每轮都要把它们查出来再筛掉, 积压越大越浪费; 而且 listExhaustedCandidates 那条路
  -- 不走 canAutoRetry, 会把作废的又当"重试用尽"处理一遍。
  AND COALESCE(${contents.metadata} -> 'deferred' ->> 'expired', 'false') <> 'true'
  AND ${contents.metadata} -> 'deferred' ->> 'requeuedAt' IS NULL
`;

/** 找出某几类原因下、还能自动重跑的内容 */
export async function listRetriableDeferred(
  reasons: DeferredReason[],
  limit = 50,
): Promise<DeferredRow[]> {
  if (reasons.length === 0) return [];
  try {
    const rows = await db
      .select({
        id: contents.id,
        tenantId: contents.tenantId,
        userId: contents.userId,
        title: contents.title,
        status: contents.status,
        metadata: contents.metadata,
      })
      .from(contents)
      .where(and(
        RETRIABLE_DEFERRED,
        inArray(sql`${contents.metadata} -> 'deferred' ->> 'reason'`, reasons),
      ))
      .orderBy(desc(contents.updatedAt))
      .limit(Math.max(1, Math.min(200, limit)));
    const out: DeferredRow[] = [];
    for (const r of rows) {
      const mark = readDeferred(r.metadata);
      if (!mark) continue;
      // 上限判定放在 JS 里而不是 SQL: retryCount 是 jsonb 文本, ::int 转换遇到脏数据会整条查询报错,
      //   而这条查询挂掉 = 所有积压内容都救不回来。宁可多取几行在内存里筛。
      if (!canAutoRetry(mark)) continue;
      out.push({ id: r.id, tenantId: r.tenantId, userId: r.userId, title: r.title, status: r.status, mark });
    }
    return out;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "deferred.list_failed — 本轮不重跑");
    return [];
  }
}

/** 重跑次数已用尽、等着转人工的那些 */
/**
 * 9-04 件 1(b): 找出超过 72 小时、仍待重跑的 deferred。
 *
 * 与 listRetriableDeferred 用同一个 RETRIABLE_DEFERRED 前置条件(未 exhausted / 未 expired /
 * 未 requeued), 差别只在**时间**: 那边要没过期的, 这边要过期的。两边互补, 不重不漏。
 */
/**
 * 9-04 件 1(a): 今天已经派出去多少条**文章**重跑。
 *
 * 判据用 `requeuedAt` 而不是新行的创建时间: 一次 defer 只重跑一次, 重跑时会在**老行**上
 * 盖 requeuedAt 并产出一条新行。所以「今天 requeuedAt 落在今天的老行数」= 今天派出的重跑篇数,
 * 与新行是否生成成功无关 —— 配额扣的是**派工**, 不是产出(失败的那次钱也花了)。
 *
 * 只数 article_generation: dvh 走 MAX_DVH_RETRY_PER_RUN 自己的预算, 不占文章配额。
 */
export async function countTodayArticleRequeues(now: Date = new Date()): Promise<number> {
  // 北京时间当天 00:00 起
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const startBj = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  const startIso = new Date(startBj.getTime() - 8 * 3600_000).toISOString();
  try {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM contents
      WHERE metadata -> 'deferred' ->> 'requeuedAt' >= ${startIso}
        AND metadata -> 'deferred' -> 'input' ->> 'kind' = 'article_generation'
    `);
    return Number((rows as unknown as { rows: Array<{ n: number }> }).rows?.[0]?.n ?? 0);
  } catch (err) {
    // 🔴 查不动时返回 0 = 不扣配额 = 退回旧行为(叠加)。这是**故意的**:
    //    宁可多生成一天, 也不要因为一次查询失败就把当天配额砍成 0 篇。
    //    但必须喊出来, 否则"配额没被扣"这件事没有任何痕迹。
    logger.warn({ err: err instanceof Error ? err.message : err }, "deferred.count_today_requeues_failed — 本次不扣配额(退回叠加行为)");
    return 0;
  }
}

export async function listExpiredDeferred(now: Date = new Date(), limit = 200): Promise<DeferredRow[]> {
  try {
    const rows = await db
      .select({
        id: contents.id, tenantId: contents.tenantId, userId: contents.userId,
        title: contents.title, status: contents.status, metadata: contents.metadata,
      })
      .from(contents)
      .where(RETRIABLE_DEFERRED)
      .limit(Math.max(1, Math.min(500, limit)));
    const out: DeferredRow[] = [];
    for (const r of rows) {
      const mark = readDeferred(r.metadata);
      if (!mark || !isDeferredExpired(mark, now)) continue;
      out.push({ id: r.id, tenantId: r.tenantId, userId: r.userId, title: r.title, status: r.status, mark });
    }
    return out;
  } catch (err) {
    // 🔴 查不动时返回空数组是安全的(这一轮不作废任何东西), 但必须喊出来 ——
    //    静默失败会表现为"积压一直不减", 和"没有积压"在指标上分不开。
    logger.warn({ err: err instanceof Error ? err.message : err }, "deferred.list_expired_failed — 本轮不作废");
    return [];
  }
}

export async function listExhaustedCandidates(limit = 50): Promise<DeferredRow[]> {
  try {
    const rows = await db
      .select({
        id: contents.id, tenantId: contents.tenantId, userId: contents.userId,
        title: contents.title, status: contents.status, metadata: contents.metadata,
      })
      .from(contents)
      .where(RETRIABLE_DEFERRED)
      .limit(Math.max(1, Math.min(200, limit)));
    const out: DeferredRow[] = [];
    for (const r of rows) {
      const mark = readDeferred(r.metadata);
      if (!mark || mark.exhausted) continue;
      if (mark.retryCount < DEFERRED_MAX_RETRY) continue;
      out.push({ id: r.id, tenantId: r.tenantId, userId: r.userId, title: r.title, status: r.status, mark });
    }
    return out;
  } catch {
    return [];
  }
}

/** 局部更新 deferred 块里的几个字段(retryCount / requeuedAt / exhausted …) */
export async function patchDeferred(contentId: string, patch: Partial<DeferredMark>): Promise<void> {
  try {
    await db
      .update(contents)
      .set({
        metadata: sql`jsonb_set(
          COALESCE(${contents.metadata}, '{}'::jsonb),
          '{deferred}',
          COALESCE(${contents.metadata} -> 'deferred', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(contents.id, contentId));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, contentId }, "deferred.patch_failed");
  }
}

/** 重跑成功 → 摘掉 deferred 块(否则它会一直在列表里显示"待重试") */
export async function clearDeferred(contentId: string): Promise<void> {
  try {
    await db
      .update(contents)
      .set({
        metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) - 'deferred'`,
        updatedAt: new Date(),
      })
      .where(eq(contents.id, contentId));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, contentId }, "deferred.clear_failed");
  }
}

/** 按原因统计当前积压(简报用) + 最早那条是什么时候失败的(算"已停摆 N 小时") */
export async function countDeferredBacklog(): Promise<{
  total: number;
  byReason: Record<string, number>;
  oldestFailedAt: string | null;
}> {
  try {
    const rows = await db
      .select({
        reason: sql<string>`${contents.metadata} -> 'deferred' ->> 'reason'`,
        count: sql<number>`count(*)::int`,
        oldest: sql<string>`min(${contents.metadata} -> 'deferred' ->> 'failedAt')`,
      })
      .from(contents)
      .where(RETRIABLE_DEFERRED)
      .groupBy(sql`${contents.metadata} -> 'deferred' ->> 'reason'`);
    const byReason: Record<string, number> = {};
    let total = 0;
    let oldest: string | null = null;
    for (const r of rows) {
      const key = r.reason ?? "unknown";
      byReason[key] = Number(r.count ?? 0);
      total += Number(r.count ?? 0);
      if (r.oldest && (!oldest || r.oldest < oldest)) oldest = r.oldest;
    }
    return { total, byReason, oldestFailedAt: oldest };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "deferred.backlog_count_failed");
    return { total: 0, byReason: {}, oldestFailedAt: null };
  }
}
