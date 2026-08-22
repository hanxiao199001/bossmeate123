/**
 * P0-B watchdog：检测卡死的 generating 文章并自动 → failed。
 *
 * spec：generating 状态超过 10 分钟（statusUpdatedAt < NOW() - 10min）
 * 自动 transitionToStatus(id, 'failed', {errorMessage: 'Generation timeout (10 minutes)'})
 *
 * 设计：
 * - setInterval 每 1 分钟跑一次（spec），不依赖 BullMQ（轻量场景过度工程）
 * - 用 transitionToStatus 而非直接 UPDATE，确保走状态机（generating → failed 是合法转移）
 * - 启动时机：server boot 时 startWatchdog()；shutdown 时 stopWatchdog()
 * - 失败转移由 InvalidTransitionError race 包住（其他 worker 可能同时改了 status）
 */
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { and, eq, lt, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { transitionToStatus, InvalidTransitionError } from "./state-machine.js";

/**
 * 🔴 判死线。**默认 30 分钟，可由运营在参数页改**（`watchdog.timeoutMinutes`）。
 *
 * ## 为什么从 10 分钟提到 30（8-18）
 *
 * 8-17 那晚的耗时分布：
 *
 * ```
 * 成功的 20 条   min 2.6 / 均 6.9 / max 9.7 分钟      超 10 分的: 0
 * 被判死的 3 条  23.4 ~ 41.2 分钟
 * ```
 *
 * **成功组的最大值 9.7 分钟，距离当时那条 10 分钟的线只差 18 秒 —— 余量 3%。**
 * 阈值正好压在分布顶部，LLM 慢一点或队列挤一点就越线。
 *
 * 越线之后并不是"止损"，而是纯浪费：**生成没有停**，继续跑到 34-41 分钟才完成，
 * LLM 的钱全花了、内容也算出来了（11027 / 11420 / 6736 字），
 * 然后因为状态已被判死，最后那步 `generating → generated` 撞状态机、产出作废。
 *
 * **40 分钟**，由两个约束共同决定（取更严的那个）：
 *   · ≥ 3× 实测 max（9.7 × 3 ≈ 30）
 *   · ≥ 3× **心跳最坏间隔** —— 心跳间隔必须 ≤ 阈值的 1/3，否则"慢但活着"仍会被误杀；
 *     链路上最坏的一段是六维质检单次（当前 **10 分钟** = 2 × 300s，推算见 `worstHeartbeatGapMs`）。
 *
 * ### 🔴 8-22 更正：原来那个 12 分钟是错的，而 40 这个结论侥幸是对的
 *
 * 原文写的是「`AI_QUALITY_CHECK_TIMEOUT_MS 180s` × `withRetry` 4 次 = 12 分钟」。
 * **这个乘法不成立** —— `utils/retry.ts` 的 `defaultShouldRetry` 第一条就是：
 *
 * ```ts
 * // ① 超时/中断 —— 最优先, 永不重试
 * if (isAbortLike(error)) return false;
 * ```
 *
 * 质检超时正是 AbortController 掐断 → AbortError → **`withRetry` 一次都不重试**。
 * 那 4 次只对 429/5xx/连接瞬断生效，而那些是快失败。
 *
 * 真实的最坏路径在**外层** `MAX_SCORE_ATTEMPTS` 循环：超时 → `cls="timeout"`
 * → 立刻转 fallback；而 `tier==="fallback"` 即 `willBeLast`。所以是
 * **最多 2 次全额超时**（最坏混合路径：primary 快失败 + primary 超时 + fallback 超时）。
 *
 * ```
 * 180s 时代（8-18 写这段时）  2 × 180s = 6 分     原文写 12 分
 * 8-22 起 timeout=300s        2 × 300s = 10 分    （见 SIX_DIM_MAX_TOKENS 那次改动）
 *
 * （最坏混合路径 = primary 快失败 + primary 超时 + fallback 超时，
 *   比纯 2× 多一次快失败的零头，不足 1 分钟，不改变结论。）
 * ```
 *
 * 40 分钟阈值当初是按虚高的 12 分推出来的（`36 = 12 × 3`）。
 * **结论侥幸偏保守（余量比以为的更大），但依据是错的。**
 *
 * 🔴 **为什么必须把这件事写出来，而不是默默把 12 改成 6：**
 * 这个阈值的正当性挂在"最坏间隔 × 3"这条推算上。
 * 如果哪天依据变了 —— 比如真给超时加了重试、或者 `MAX_SCORE_ATTEMPTS` 改大、
 * 或者 fallback 不再是最后一跳 —— **阈值就该跟着变**。
 * 而如果只改数不改理由，下一个人看到的是一个对得上的数字，
 * 不会知道它是怎么来的，也就不会知道它什么时候该重算。
 *
 * 当前余量：10 分 × 3 = 30 ≤ 40 ✅（改动前是 6 × 3 = 18）。
 * **再抬 timeout 前先算这一步** —— `timeout > 40/3/2 = 6.67 分钟`（400 秒）就会越线。
 * 这条已由 `p0-b-watchdog.test.ts` 写死断言，不再靠人记得。
 *
 * 打点位置与点间最坏耗时（8-18 实测/推算，接线时按此表打）：
 *
 * ```
 * A draft→generating 之后          ——
 * B 主生成 LLM 返回后        A→B   8 分  (AI_ARTICLE_TIMEOUT 120s × 4)
 * C 标题生成返回后            B→C   3 分  (AI_FAST 45s × 4)
 * D condense 返回后           C→D   8 分
 * E 去 AI 腔返回后            D→E   8 分
 * F 六维质检返回后            E→F  10 分  ← 最坏的一段（8-22 更正，见上方；
 *                                       = 2 × AI_QUALITY_CHECK_TIMEOUT_MS 300s，
 *                                       **不是** ×4，超时不进 withRetry）
 * G 每轮定向重写返回后        F→G   8 分  (≤2 轮)
 * H 出稿健康闸之后            G→H  ≈0
 * ```
 *
 * 为什么不把心跳打进 `withRetry` 的每次尝试（那样最坏只 3 分）：
 * **失败的重试不是进展**，那是假心跳 —— 它证明的是"进程还在内存里"，
 * 不是"活干到哪了"。为迁就观测手段去改业务重试策略同样本末倒置。
 *
 * **下一个想调紧的人，先看上面这两组数。**
 *
 * ⚠️ 真正的根治是**心跳**（见 `touchGenerationHeartbeat`）：现在 watchdog 杀的是
 * "跑得慢的"，而"慢"和"死"在数据上分不清。心跳跑稳一周之后这条线才谈得上回调。
 */
/**
 * 心跳最坏间隔的推算 —— **只写这一处**，watchdog 文件头、`p0-b-watchdog.test.ts`、
 * `runtime-params` 的运营文案原来各抄了一份 12 分钟，三处都错且要分别改。
 *
 * 链路最坏的一段是六维质检单次 = **最多 2 次全额超时**：
 * 超时 → `cls="timeout"` → 立刻转 fallback；而 `tier==="fallback"` 即 `willBeLast`。
 *
 * 🔴 **不是** `× withRetry 4 次` —— `defaultShouldRetry` 第一条
 * 「超时/中断，永不重试」把 abort 直接放弃了，那 4 次只对 429/5xx 生效。
 * 8-18 原推算就错在这里，见文件头。
 */
export function worstHeartbeatGapMs(qualityCheckTimeoutMs: number): number {
  return 2 * qualityCheckTimeoutMs;
}

/** 心跳间隔必须 ≤ 阈值的 1/3，否则"慢但活着"会被误杀。这是 40 这个数的第二个约束。 */
export const HEARTBEAT_GAP_SAFETY_FACTOR = 3;

export const WATCHDOG_TIMEOUT_FALLBACK_MINUTES = 40;
export const WATCHDOG_TIMEOUT_MS = WATCHDOG_TIMEOUT_FALLBACK_MINUTES * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 60 * 1000; // 1 分钟
export const WATCHDOG_ERROR_MESSAGE = "Generation timeout (10 minutes)";
// 6-17 #6: needs_review 超过 7 天无人处理 → 自动归档, 防质检未过的内容永远卡 feed「待审」越积越多
export const NEEDS_REVIEW_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * 单次检测：找出所有 generating + 超时的 row，逐个 → failed。
 * 返回 {stuck, failed}：stuck=匹配条件总数，failed=真转成功数。
 *
 * @param now 测试用注入；生产用默认 new Date()
 */
export async function checkStuckGenerating(
  now: Date = new Date(),
  /**
   * 判死线。**由调用方读取运行时参数后传入**，本函数不自己读 ——
   * 检测函数多打一次 DB 会让它更难测（8-18 实测：加了参数读取之后，
   * 测试 mock 的返回序列被这次额外查询吃掉，三条用例全挂），
   * 而且"读配置"和"扫超时"本就是两件事。
   */
  timeoutMs: number = WATCHDOG_TIMEOUT_MS,
): Promise<{ stuck: number; failed: number }> {
  const cutoff = new Date(now.getTime() - timeoutMs);
  const stuckRows = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.status, "generating"), lt(contents.statusUpdatedAt, cutoff)));

  let failedCount = 0;
  for (const row of stuckRows) {
    try {
      await transitionToStatus(row.id, "failed", { errorMessage: WATCHDOG_ERROR_MESSAGE });
      failedCount++;
      /**
       * ⚠️ 心跳**尚未接进生成链路**，所以此刻分不出「慢」与「死」——
       * 这时若按 hasRecentHeartbeat 的返回值去标 slow/dead，
       * 结果会是「全部标成真死」，而那是**假话**（8-17 那 3 篇明明还在跑）。
       * 所以现在只记一种，并在文案里明说分不出来；
       * 等 `touchGenerationHeartbeat` 接线后再拆成 slow / dead 两类。
       */
      void reportWatchdogKill(row.id, timeoutMs);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // race：可能业务流程刚好把它转走了（→ generated / → archived）
        logger.warn(
          { id: row.id, reason: err.reason },
          "P0-B watchdog: 状态转移 race，跳过（业务流程已介入）",
        );
      } else {
        logger.error({ id: row.id, err }, "P0-B watchdog: 转移异常");
      }
    }
  }

  if (stuckRows.length > 0) {
    logger.info(
      { stuck: stuckRows.length, failed: failedCount, cutoff: cutoff.toISOString() },
      "P0-B watchdog: 一轮处理完成",
    );
  }
  return { stuck: stuckRows.length, failed: failedCount };
}

/**
 * 启动 watchdog 周期任务（server boot 时调用）。幂等：重复启动只 warn 不重启。
 */
export function startWatchdog(): void {
  if (intervalHandle !== null) {
    logger.warn("P0-B watchdog: 已启动，跳过");
    return;
  }
  intervalHandle = setInterval(() => {
    void (async () => {
      // 定时器这层负责读配置(DB → env → 默认); 读失败退回默认, 参数系统不该成为新故障点
      let timeoutMs = WATCHDOG_TIMEOUT_MS;
      try {
        const { getParam } = await import("../ops/runtime-params.js");
        timeoutMs = (await getParam<number>("watchdog.timeoutMinutes")) * 60 * 1000;
      } catch { /* 用默认 */ }
      await checkStuckGenerating(new Date(), timeoutMs);
    })().catch((err) =>
      logger.error({ err }, "P0-B watchdog: 顶层未捕获异常"),
    );
    checkStaleNeedsReview().catch((err) =>
      logger.error({ err }, "#6 needs_review 归档: 顶层未捕获异常"),
    );
  }, WATCHDOG_INTERVAL_MS);
  logger.info(
    { intervalMs: WATCHDOG_INTERVAL_MS, timeoutMs: WATCHDOG_TIMEOUT_MS },
    "P0-B watchdog: 启动 ✅",
  );
}

/**
 * #6: needs_review 超时(默认 7 天)自动归档。needs_review→archived 是合法转移。
 */
export async function checkStaleNeedsReview(
  timeoutMs: number = NEEDS_REVIEW_TIMEOUT_MS,
): Promise<{ stale: number; archived: number }> {
  const cutoff = new Date(Date.now() - timeoutMs);
  const rows = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.status, "needs_review"), lt(contents.statusUpdatedAt, cutoff)));
  let archived = 0;
  for (const row of rows) {
    try {
      await transitionToStatus(row.id, "archived");
      archived++;
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) logger.error({ id: row.id, err }, "#6 needs_review 归档异常");
    }
  }
  if (rows.length > 0) logger.info({ stale: rows.length, archived }, "#6 needs_review 超时自动归档完成");
  return { stale: rows.length, archived };
}

/** 停止 watchdog（shutdown / 测试用）。 */
export function stopWatchdog(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info("P0-B watchdog: 已停止");
  }
}

// ══════════════════════════════════════════════════════════════════
// 心跳 —— 区分「慢」与「死」
// ══════════════════════════════════════════════════════════════════
//
// 🔴 心跳必须打在**真正的工作循环里**，不能挂在外层定时器上。
//
// 外层 setInterval 在进程卡死、事件循环被阻塞、工作协程早已异常退出时
// **照样会跳** —— 那不是"我在干活"的证据，只是"我还在内存里"。
// （红线 #14 家族：降级/信号必须与真产物同源，否则它证明的是另一件事。）
//
// 间隔要求：**≤ 阈值的 1/3**。30 分钟的判死线 → 10 分钟内必须有一次心跳，
// 否则"慢但活着"的生成仍会被误杀 —— 那正是 8-17 要修的那件事。

/** 心跳间隔上限 = 判死线的 1/3 */
export const HEARTBEAT_MAX_INTERVAL_RATIO = 1 / 3;

/**
 * 打一次心跳。**在生成的工作循环里调**（每完成一个可观测的步骤就调一次），
 * 不要包进定时器。
 */
export async function touchGenerationHeartbeat(contentId: string, point: string): Promise<void> {
  try {
    await db
      .update(contents)
      .set({
        metadata: sql`coalesce(${contents.metadata}, '{}'::jsonb)
          || jsonb_build_object('genHeartbeatAt', to_jsonb(now()))
          || jsonb_build_object('genHeartbeatPoint', ${point}::text)
          || jsonb_build_object('genHeartbeatPoints',
               coalesce(${contents.metadata}->'genHeartbeatPoints', '[]'::jsonb) || to_jsonb(${point}::text))`,
      })
      .where(eq(contents.id, contentId));
  } catch (err) {
    // 🔴 心跳失败**绝不能打断生成** —— 它是观测手段, 不是业务步骤。
    //   与"旁路告警绝不搞挂主流程"同源: 观测不许有业务影响力。
    logger.warn({ contentId, point, err: err instanceof Error ? err.message : err }, "watchdog.heartbeat_failed");
  }
}

/**
 * 本次生成打到了哪些点 —— **接线完整性验证用**。
 *
 * 「没报错」不等于「接上了」：少接一个点不会报任何错，只会静默留个洞，
 * 而那个洞正好是心跳最该覆盖的那一段（台账 codes:9 那次的同款教训）。
 * 所以验收是「跑一次真实生成，确认 8 个点全部出现」，不是「跑完没报错」。
 */
export const EXPECTED_HEARTBEAT_POINTS = [
  "A_generating",
  "B_article_llm",
  "C_titles",
  "D_condense",
  "E_decliche",
  "F_sixdim",
  "H_output_health",
] as const;
/** G 是重写轮次，按需出现（质检一次过就没有），所以不在必达列表里 */
export const OPTIONAL_HEARTBEAT_POINT_PREFIX = "G_rewrite_round";

/** 这条内容在判死窗口内有没有心跳 */
export async function hasRecentHeartbeat(contentId: string, windowMs: number): Promise<boolean> {
  try {
    const [row] = await db
      .select({ hb: sql<string | null>`${contents.metadata}->>'genHeartbeatAt'` })
      .from(contents)
      .where(eq(contents.id, contentId))
      .limit(1);
    if (!row?.hb) return false;
    return Date.now() - new Date(row.hb).getTime() < windowMs;
  } catch {
    return false;
  }
}

/**
 * 判死要出声。**8-17 那 3 篇被判死时只打了日志、没落 incident** ——
 * 于是「内容其实已生成 11000+ 字、钱也花了、然后被扔掉」这件事无人知晓。
 * 与背景图那个案子同构：正确地工作，安静地损失。
 */
async function reportWatchdogKill(contentId: string, timeoutMs: number): Promise<void> {
  try {
    const { recordIncidentThrottled } = await import("../ops/incidents.js");
    const mins = Math.round(timeoutMs / 60000);
    await recordIncidentThrottled(
      {
        kind: "watchdog_kill",
        severity: "warn",
        // 红线 #13: 只陈述事实, 不猜是慢还是死 —— 心跳没接线之前**确实分不出来**
        message:
          `生成超过 ${mins} 分钟被判死。⚠️ 心跳尚未接线，无法区分「跑得慢」与「真卡死」——` +
          `8-17 那 3 篇属前者（内容已生成 11000+ 字、钱已花，仍被判死）。接线后本告警将拆为 slow / dead 两类。`,
        tenantId: null,
        detail: { contentId, timeoutMinutes: mins, heartbeatWired: false },
      },
      { key: "watchdog_kill" },
    );
  } catch {
    /* 告警旁路失败不影响主流程 */
  }
}
