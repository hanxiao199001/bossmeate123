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
 * 30 = 3× 实测 max。**下一个想调紧的人，先看上面这组分布。**
 *
 * ⚠️ 真正的根治是**心跳**（见 `touchGenerationHeartbeat`）：现在 watchdog 杀的是
 * "跑得慢的"，而"慢"和"死"在数据上分不清。心跳跑稳一周之后这条线才谈得上回调。
 */
export const WATCHDOG_TIMEOUT_FALLBACK_MINUTES = 30;
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
): Promise<{ stuck: number; failed: number }> {
  // 读运行时参数(DB → env → 代码默认)。读失败自动退回默认, 参数系统不该成为新的故障点
  let timeoutMs = WATCHDOG_TIMEOUT_MS;
  try {
    const { getParam } = await import("../ops/runtime-params.js");
    timeoutMs = (await getParam<number>("watchdog.timeoutMinutes")) * 60 * 1000;
  } catch { /* 用默认 */ }
  const cutoff = new Date(now.getTime() - timeoutMs);
  const stuckRows = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.status, "generating"), lt(contents.statusUpdatedAt, cutoff)));

  let failedCount = 0;
  for (const row of stuckRows) {
    try {
      /**
       * 🔴 判死前先看心跳，两种情形语义完全不同：
       *   · **有心跳但超时** = 真慢 → 阈值可能仍偏紧，记 warn
       *   · **无心跳超时**   = 真死 → 记 error
       * 混在一起记，就会出现 8-17 那种「3 篇被判死没人知道」。
       */
      const alive = await hasRecentHeartbeat(row.id, timeoutMs);
      await transitionToStatus(row.id, "failed", {
        errorMessage: alive ? `${WATCHDOG_ERROR_MESSAGE}（有心跳，疑似阈值偏紧）` : WATCHDOG_ERROR_MESSAGE,
      });
      failedCount++;
      void reportWatchdogKill(row.id, alive, timeoutMs);
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
    checkStuckGenerating().catch((err) =>
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
export async function touchGenerationHeartbeat(contentId: string): Promise<void> {
  try {
    await db
      .update(contents)
      .set({ metadata: sql`coalesce(${contents.metadata}, '{}'::jsonb) || jsonb_build_object('genHeartbeatAt', to_jsonb(now()))` })
      .where(eq(contents.id, contentId));
  } catch (err) {
    // 心跳失败绝不能打断生成 —— 它是观测手段, 不是业务步骤
    logger.warn({ contentId, err: err instanceof Error ? err.message : err }, "watchdog.heartbeat_failed");
  }
}

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
async function reportWatchdogKill(contentId: string, alive: boolean, timeoutMs: number): Promise<void> {
  try {
    const { recordIncidentThrottled } = await import("../ops/incidents.js");
    await recordIncidentThrottled(
      {
        kind: alive ? "watchdog_kill_slow" : "watchdog_kill_dead",
        severity: alive ? "warn" : "error",
        message: alive
          ? `生成超时被判死，但**有心跳** —— 它在跑，只是超过了 ${Math.round(timeoutMs / 60000)} 分钟的线。阈值可能偏紧，产出被浪费。`
          : `生成超时被判死，且**无心跳** —— 判定为真卡死（${Math.round(timeoutMs / 60000)} 分钟无进展）。`,
        tenantId: null,
        detail: { contentId, hadHeartbeat: alive, timeoutMinutes: Math.round(timeoutMs / 60000) },
      },
      { key: alive ? "watchdog_kill_slow" : "watchdog_kill_dead" },
    );
  } catch {
    /* 告警旁路失败不影响主流程 */
  }
}
