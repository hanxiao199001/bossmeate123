/**
 * 8-03 服务恢复探测 + 自动重跑 —— 把"充完值/服务恢复后要有人去重跑"这件事从人身上拿走。
 *
 * 【事故链】8-03 百炼欠费 → 质检主备模型同时失败(共用一个阿里云账户) → 9 篇判 needs_review;
 *   老板那条 157 字口播稿 TTS 失败硬中止, 稿子丢了。充值之后, **没有任何东西**会去把这些
 *   内容重跑一遍 —— 运营也不会做这个。于是欠费 30 分钟, 损失的是这 30 分钟里所有内容。
 *
 * 【为什么必须真实计费调用, 不能用 /models 探测】
 *   8-03 排查时实测: 账户欠费状态下 GET /models 照样返回 200 + 完整模型列表。
 *   计费拦截发生在**推理请求**这一层, 不在列表这一层。用 /models 探测 = 永远探不出欠费,
 *   等于没有探测。所以这里老老实实发一次最短的真实推理请求(几厘钱)。
 *
 * 【成本】
 *   单次: LLM ≈ 10 token 以内(< 0.001 元) + TTS 2 个字(< 0.001 元)。
 *   三道刹车, 一天最多几毛:
 *     ① **没有积压就不探测** —— 没有等着被救的内容, 探测只是纯烧钱(最有效的一条);
 *     ② 连续失败退避 —— 30min → 60min → 2h(欠费期间一探必失败, 不退避就是在欠费时持续烧钱);
 *     ③ DVH **不探测** —— 一次提交就是几块钱, 靠 LLM/TTS 的结果推断即可(同一个阿里云账户)。
 */
import { logger } from "../../config/logger.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { recordIncident, recordIncidentThrottled } from "./incidents.js";
import { classifyFailure, FAILURE_KIND_LABEL, type FailureKind } from "./failure-kind.js";
import {
  DEFERRED_MAX_RETRY,
  countDeferredBacklog,
  listExhaustedCandidates,
  listRetriableDeferred,
  patchDeferred,
  clearDeferred,
  type DeferredRow,
} from "./deferred.js";

// ============ 退避(纯函数, 直接单测) ============

export type ProbeTarget = "llm" | "tts";

/** 基准探测间隔 —— scheduler 每 30 分钟叫一次, 没失败时就是这个节奏 */
export const PROBE_BASE_INTERVAL_MS = 30 * 60_000;
/** 退避上限: 停摆期间最慢 2 小时探一次(再慢的话恢复后的响应就不像"自动"了) */
export const PROBE_MAX_INTERVAL_MS = 2 * 3600_000;

/**
 * 连续失败 N 次后, 下一次探测该等多久。
 *   0~1 次失败 → 30 分钟(刚挂, 可能马上就好, 探勤一点)
 *   2 次       → 60 分钟
 *   ≥3 次      → 120 分钟(封顶; 这个量级的停摆多半是欠费, 得等人去充值)
 * 欠费时账户一直不通, 不退避就是"欠着费还在持续花钱探测"。
 */
export function nextProbeIntervalMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return PROBE_BASE_INTERVAL_MS;
  const ms = PROBE_BASE_INTERVAL_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 3));
  return Math.min(ms, PROBE_MAX_INTERVAL_MS);
}

interface ProbeState {
  consecutiveFailures: number;
  lastProbeAt: number;
  nextAllowedAt: number;
  lastOk: boolean | null;
  lastError?: string;
}

const probeState = new Map<ProbeTarget, ProbeState>();

function getState(target: ProbeTarget): ProbeState {
  let st = probeState.get(target);
  if (!st) {
    st = { consecutiveFailures: 0, lastProbeAt: 0, nextAllowedAt: 0, lastOk: null };
    probeState.set(target, st);
  }
  return st;
}

/** 仅供单测重置(线上没有调用方) */
export function __resetProbeState(): void {
  probeState.clear();
}

/** 排障用: 当前退避状态 */
export function getProbeState(): Record<string, ProbeState> {
  return Object.fromEntries(probeState.entries());
}

/** 到点了没(退避窗口内直接跳过, 不发请求 = 不花钱) */
export function shouldProbeNow(target: ProbeTarget, now = Date.now()): boolean {
  return now >= getState(target).nextAllowedAt;
}

// ============ 探测实现 ============

export interface ProbeResult {
  target: ProbeTarget;
  ok: boolean;
  /** 本轮是否真的发了请求(false = 在退避窗口里跳过了) */
  probed: boolean;
  error?: string;
  kind?: FailureKind;
}

/** 探测超时: 探测本身不该卡住 scheduler, 20 秒还没回等于"不可用" */
const PROBE_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} 探测超时(${ms}ms)`)), ms)),
  ]);
}

/**
 * LLM 探测: 对**生成任务的主模型**发一次最短的真实推理请求。
 *
 * 刻意不走 chat-service 的 chat(): 那里有主备回退, 备用模型通了就返回成功 ——
 * 而 8-03 的病根恰恰是"主备共用一个阿里云账户", 我们要探的是**那个账户通不通**,
 * 不是"随便哪个模型能不能出字"。所以直连 primary。
 * 成功时顺手 recordSuccess 复位熔断器 —— 服务真回来了, 别让半开窗口再拖 5 分钟。
 */
export async function probeLlm(): Promise<ProbeResult> {
  try {
    const { modelRouter } = await import("../ai/model-router.js");
    const { OpenAICompatibleProvider } = await import("../ai/providers/openai-compatible.js");
    const choice = modelRouter.selectModel("content_generation");
    if (!choice) {
      return { target: "llm", ok: false, probed: true, error: "无可用模型配置(路由表空/缺 API Key)", kind: "service_down" };
    }
    const provider = new OpenAICompatibleProvider(choice.name, choice.apiKey, choice.baseUrl, choice.model);
    const res = await withTimeout(
      provider.chat({
        // 最短提示 + maxTokens 极小: 计费按 token, 这一次不到一厘钱
        messages: [{ role: "user", content: "ok" }],
        maxTokens: 4,
        temperature: 0,
      }),
      PROBE_TIMEOUT_MS,
      "LLM",
    );
    if (typeof res.content !== "string") {
      return { target: "llm", ok: false, probed: true, error: "响应无 content", kind: "service_down" };
    }
    modelRouter.recordSuccess(choice.name, choice.model);
    return { target: "llm", ok: true, probed: true };
  } catch (err) {
    const kind = classifyFailure(err);
    return {
      target: "llm", ok: false, probed: true, kind,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

/**
 * TTS 探测: 合成 2 个字。
 *
 * ⚠️ 判据是 `fellSilent === false` 而不是"没抛异常" —— TTSService 四个 provider 分支
 *   全是"合成失败 → 静音兜底", 它**从不抛错**。只看有没有异常等于永远探测成功
 *   (这正是 7-31 哑巴视频事故的同一个坑, 别在探测器里再踩一次)。
 */
export async function probeTts(): Promise<ProbeResult> {
  try {
    const { ttsService } = await import("../video/tts-service.js");
    const r = await withTimeout(
      ttsService.synthesize(SYSTEM_RECOMMENDATION_TENANT_ID, "你好", { format: "mp3" }),
      PROBE_TIMEOUT_MS,
      "TTS",
    );
    if (r.fellSilent) {
      return { target: "tts", ok: false, probed: true, error: "TTS 降级为静音(合成失败或凭证未配)", kind: "service_down" };
    }
    return { target: "tts", ok: true, probed: true };
  } catch (err) {
    const kind = classifyFailure(err);
    return {
      target: "tts", ok: false, probed: true, kind,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

/** 跑一次探测并更新退避状态。返回 probed=false 表示在退避窗口里, 没花钱。 */
async function probeWithBackoff(target: ProbeTarget, now = Date.now()): Promise<ProbeResult> {
  const st = getState(target);
  if (now < st.nextAllowedAt) {
    return { target, ok: st.lastOk === true, probed: false };
  }
  const res = target === "llm" ? await probeLlm() : await probeTts();
  st.lastProbeAt = now;
  if (res.ok) {
    st.consecutiveFailures = 0;
    st.nextAllowedAt = now + PROBE_BASE_INTERVAL_MS;
    delete st.lastError;
  } else {
    st.consecutiveFailures += 1;
    st.nextAllowedAt = now + nextProbeIntervalMs(st.consecutiveFailures);
    st.lastError = res.error ?? "";
    // 节流: 停摆期间每轮都会失败, 逐条落库会把 ops_incidents 刷屏, 把别的告警淹了
    void recordIncidentThrottled({
      kind: "service_probe_failed",
      severity: "warn",
      message: `${target === "llm" ? "AI 模型" : "语音合成"}仍未恢复(连续 ${st.consecutiveFailures} 次探测失败, 已拉长到每 ${Math.round(nextProbeIntervalMs(st.consecutiveFailures) / 60000)} 分钟探一次): ${res.error ?? ""}`.slice(0, 400),
      detail: { target, consecutiveFailures: st.consecutiveFailures, kind: res.kind ?? null, error: res.error ?? null },
    }, { key: `service_probe_failed:${target}` });
  }
  const wasOk = st.lastOk;
  st.lastOk = res.ok;
  // 由"不通"变"通" = 恢复事件(第一次探测就通不算恢复, 那是本来就没坏)
  if (res.ok && wasOk === false) {
    void recordIncident({
      kind: "service_recovered",
      severity: "warn",
      message: `${target === "llm" ? "AI 模型" : "语音合成"}已恢复, 开始自动重跑积压内容`,
      detail: { target },
    });
  }
  return res;
}

// ============ 自动重跑 ============

export interface RetryOutcome {
  requeued: number;
  skipped: number;
  exhausted: number;
  byKind: Record<string, number>;
}

/**
 * 单轮 DVH 重跑上限。**每条都是几块钱的付费视频**, 一次全放出去等于服务一恢复就先烧一笔。
 * 剩下的下一轮(30 分钟后)继续 —— 积压本来就不该一次性冲出去。
 */
const MAX_DVH_RETRY_PER_RUN = 3;

/**
 * 把积压的 deferred 内容重新跑起来。
 *
 * @param avail 各依赖当前是否可用。DVH **不单独探测**, 由 llm && tts 推断
 *   (同一个阿里云账户, TTS 通了账户就通; 而 DVH 探测一次就是几块钱)。
 */
export async function retryDeferredContents(avail: { llm: boolean; tts: boolean }): Promise<RetryOutcome> {
  const out: RetryOutcome = { requeued: 0, skipped: 0, exhausted: 0, byKind: {} };

  // ① 先把"重试次数用尽"的转人工 —— 别让一条永远坏的内容每 30 分钟烧一次钱
  for (const row of await listExhaustedCandidates(50)) {
    await patchDeferred(row.id, { exhausted: true });
    out.exhausted += 1;
    void recordIncident({
      kind: "deferred_retry_exhausted",
      severity: "error",
      tenantId: row.tenantId,
      message: `内容已自动重试 ${row.mark.retryCount} 次仍失败, 转人工: 《${(row.title ?? "").slice(0, 40)}》 — ${row.mark.detail}`,
      detail: {
        contentId: row.id, reason: row.mark.reason, retryCount: row.mark.retryCount,
        inputKind: (row.mark.input as { kind?: string } | undefined)?.kind ?? null,
        lastError: row.mark.lastError ?? null,
      },
    });
  }

  if (!avail.llm && !avail.tts) return out;

  const rows = await listRetriableDeferred(["quota_exceeded", "service_down"], 100);
  let dvhBudget = MAX_DVH_RETRY_PER_RUN;

  for (const row of rows) {
    const inputKind = (row.mark.input as { kind?: string } | undefined)?.kind;
    // 依赖没恢复的那几类先放着 —— 现在跑就是白跑, 还白烧一次钱
    const needsTts = inputKind === "dvh_text";
    if (!avail.llm || (needsTts && !avail.tts)) { out.skipped += 1; continue; }
    if (needsTts && dvhBudget <= 0) { out.skipped += 1; continue; }

    try {
      const done = await dispatchRetry(row);
      if (!done) { out.skipped += 1; continue; }
      if (needsTts) dvhBudget -= 1;
      out.requeued += 1;
      out.byKind[inputKind ?? "unknown"] = (out.byKind[inputKind ?? "unknown"] ?? 0) + 1;
    } catch (err) {
      out.skipped += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : err, contentId: row.id, inputKind },
        "deferred.retry_dispatch_failed — 本条留在积压里, 下轮再试",
      );
    }
  }
  return out;
}

/** 按 input.kind 分派重跑。返回 false = 这条跑不了(input 缺字段等), 留给人工。 */
async function dispatchRetry(row: DeferredRow): Promise<boolean> {
  const input = row.mark.input as unknown as Record<string, unknown> | undefined;
  const kind = input?.kind;
  const nextCount = row.mark.retryCount + 1;

  if (kind === "article_generation") {
    const batchId = String(input?.batchId ?? "");
    const batchRowId = String(input?.batchRowId ?? "");
    if (!batchId || !batchRowId) return false;
    const { batchQueue } = await import("../batch/queue.js");
    await batchQueue.add(
      "batch-row",
      {
        batchId, batchRowId,
        rowId: batchRowId,
        tenantId: row.tenantId,
        userId: row.userId,
        isRetry: true,
        // 重跑失败时把计数带回去, 否则每次都从 0 开始 = 上限形同虚设
        deferredRetryCount: nextCount,
      },
      { jobId: `batch-${batchId}-${batchRowId}-deferred-${nextCount}` },
    );
    // 一次 defer 只重新入队一次: 重跑会产出**新的 contents 行**, 老行不封口就会被反复入队
    await patchDeferred(row.id, { retryCount: nextCount, lastRetryAt: new Date().toISOString(), requeuedAt: new Date().toISOString() });
    return true;
  }

  if (kind === "dvh_text") {
    const text = String(input?.text ?? "");
    const templateId = String(input?.templateId ?? "");
    if (!text || !templateId) return false;
    const { triggerDvhFromText } = await import("../digital-human/text-bridge.js");
    // 先封口再触发: 触发是 fire-and-forget 的长流程(1~5 分钟), 若失败会自己再落一条新的
    // deferred(带 retryCount=nextCount)。老行必须当场封口, 否则下一轮探测又会把它捞出来重跑一次
    // —— 那是**又一条几块钱的付费视频**。
    await patchDeferred(row.id, { retryCount: nextCount, lastRetryAt: new Date().toISOString(), requeuedAt: new Date().toISOString() });
    void triggerDvhFromText({
      db: (await import("../../models/db.js")).db,
      tenantId: row.tenantId,
      userId: row.userId,
      text,
      ...(input?.title ? { title: String(input.title) } : {}),
      templateId,
      ...(input?.voiceId ? { voiceId: String(input.voiceId) } : {}),
      ...(input?.backgroundUrl ? { backgroundUrl: String(input.backgroundUrl) } : {}),
      ...(input?.conversationId ? { conversationId: String(input.conversationId) } : {}),
      deferredRetryCount: nextCount,
    });
    return true;
  }

  if (kind === "quality_check") {
    // 质检是**原地重跑**(正文已落库, 不产生新行), 所以不设 requeuedAt:
    //   跑完要么摘掉 deferred(评上分了), 要么把 retryCount 留在原地等下一轮。
    await patchDeferred(row.id, { retryCount: nextCount, lastRetryAt: new Date().toISOString() });
    const ok = await rerunQualityCheck(row);
    if (ok) await clearDeferred(row.id);
    return true;
  }

  return false;
}

/** 原地重跑一篇的六维质检; 评上分了返回 true */
async function rerunQualityCheck(row: DeferredRow): Promise<boolean> {
  try {
    const { db } = await import("../../models/db.js");
    const { contents } = await import("../../models/schema.js");
    const { eq, sql } = await import("drizzle-orm");
    const [cur] = await db
      .select({ title: contents.title, body: contents.body, status: contents.status })
      .from(contents)
      .where(eq(contents.id, row.id))
      .limit(1);
    if (!cur?.body) return false;

    const { runArticleQualityPasses, qualityPipelineMeta } = await import("../content-engine/quality-pipeline.js");
    const journalId = (row.mark.input as { journalId?: string | null } | undefined)?.journalId;
    const qp = await runArticleQualityPasses({
      tenantId: row.tenantId,
      userId: row.userId,
      title: cur.title ?? "",
      body: cur.body,
      contentId: row.id,
      ...(journalId ? { journalId } : {}),
    });
    if (qp.sixDim?.degraded) return false; // 还是没评上分 → 留在积压里等下一轮

    const meta = qualityPipelineMeta(qp);
    await db
      .update(contents)
      .set({
        ...(qp.changed ? { body: qp.body } : {}),
        metadata: sql`COALESCE(${contents.metadata}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(contents.id, row.id));

    // 8-05 【影子模式】重评了, 但**不自动放行** —— 重评结果只写进 metadata, 状态保持 needs_review。
    //
    // 原设计是"质检通过就 transitionStatus(needs_review → generated)"自动进可发池。老板拍板改保守, 两条理由:
    //   ① 这批内容恰恰是**故障期间生成**的 —— 生成时质检就是挂的, 内容本身从没被完整检查过;
    //   ② 不符合渐进移交: 第一次上线就全自动, 而"探测→重跑→放行"整条链路**没有任何人工介入点**,
    //      判断一旦有偏差, 错误会静默累积(而且累积的是"已发出去的内容", 不可逆)。
    //
    // 影子模式怎么退出: 积累一两周, 比对「系统重评通过」vs「运营确认放行」的一致率。
    //   一致率高了再把下面这段放开, 那时候切才有依据 —— 现在切只是赌它对。
    //   放开时就是恢复这三行:
    //     const { transitionStatus } = await import("../articles/state-machine.js");
    //     try { await transitionStatus(row.id, "needs_review", "generated"); } catch { /* 尊重人工结果 */ }
    //   条件同原设计: qp.qualityLoop.passed && cur.status === "needs_review"。
    //
    // 注: 重评分数已在上面写进 metadata, 运营在待审列表里看得到分, 不是让人裸判。
    if (qp.qualityLoop.passed && cur.status === "needs_review") {
      logger.info(
        { contentId: row.id, finalTotal: qp.qualityLoop.finalTotal ?? null },
        "deferred.rerun_passed_but_held — 重评通过, 影子模式下仍留待审等人工确认(不自动放行)",
      );
    }
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, contentId: row.id }, "deferred.quality_rerun_failed");
    return false;
  }
}

// ============ 入口(scheduler 每 30 分钟叫一次) ============

export interface ProbeRunResult {
  skipped: boolean;
  reason?: string;
  backlog: number;
  probes: ProbeResult[];
  retry?: RetryOutcome;
}

/**
 * 一轮"探测 + 自动重跑"。scheduler 每 30 分钟调一次, 真正探不探由退避与积压量决定。
 * 绝不抛错 —— 它是旁路, 挂了不能反过来把 scheduler 搞挂。
 */
export async function runServiceHealthProbe(now = Date.now()): Promise<ProbeRunResult> {
  try {
    const backlog = await countDeferredBacklog();

    // 🔴 成本控制第一条: 没有积压 = 没有等着被救的内容, 这一轮探测纯属烧钱, 直接不探。
    //   (系统本身通不通有 /health 拨测在管, 那条不花钱。)
    if (backlog.total === 0) {
      return { skipped: true, reason: "no_backlog", backlog: 0, probes: [] };
    }

    // 只有积压里真有 DVH 稿子时才探 TTS —— 否则 TTS 探测对本轮毫无用处
    const rows = await listRetriableDeferred(["quota_exceeded", "service_down"], 100);
    const needTts = rows.some((r) => (r.mark.input as { kind?: string } | undefined)?.kind === "dvh_text");

    const probes: ProbeResult[] = [];
    probes.push(await probeWithBackoff("llm", now));
    if (needTts) probes.push(await probeWithBackoff("tts", now));

    const llmOk = probes.find((p) => p.target === "llm")?.ok ?? false;
    const ttsOk = needTts ? (probes.find((p) => p.target === "tts")?.ok ?? false) : true;

    const retry = await retryDeferredContents({ llm: llmOk, tts: ttsOk });
    logger.info(
      { backlog: backlog.total, byReason: backlog.byReason, llmOk, ttsOk, retry },
      "8-03 服务恢复探测完成",
    );
    return { skipped: false, backlog: backlog.total, probes, retry };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "服务恢复探测异常(本轮跳过, 不影响业务)");
    return { skipped: true, reason: "error", backlog: 0, probes: [] };
  }
}

/**
 * 简报用: 积压概况 + 已停摆多久。
 * "N 条内容因 XX 服务不可用暂停, 服务恢复后会自动重跑" —— 运营看这一行就够了。
 */
export async function collectDeferredSummary(now = new Date()): Promise<{
  total: number;
  byReason: Record<string, number>;
  stalledHours: number | null;
  text: string | null;
}> {
  const backlog = await countDeferredBacklog();
  if (backlog.total === 0) return { total: 0, byReason: {}, stalledHours: null, text: null };
  let stalledHours: number | null = null;
  if (backlog.oldestFailedAt) {
    const t = Date.parse(backlog.oldestFailedAt);
    if (Number.isFinite(t)) stalledHours = Math.max(0, Math.round((now.getTime() - t) / 3600_000));
  }
  const parts = Object.entries(backlog.byReason)
    .map(([reason, n]) => `${FAILURE_KIND_LABEL[reason as FailureKind] ?? reason} ${n} 条`)
    .join(" / ");
  const stalled = stalledHours !== null && stalledHours >= 1 ? `已停摆约 ${stalledHours} 小时, ` : "";
  return {
    total: backlog.total,
    byReason: backlog.byReason,
    stalledHours,
    text: `${stalled}${backlog.total} 条内容因外部服务不可用暂停(${parts}), 原稿已保存, 服务恢复后会自动重跑(最多自动重试 ${DEFERRED_MAX_RETRY} 次)`,
  };
}
