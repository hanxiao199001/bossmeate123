/**
 * P0：article lifecycle state machine（5-9 / 5-10 工期）。
 *
 * 状态全集 / 转移表见 ./status-vocabulary.ts（7 个状态，含 PR-U2 的 needs_review）。
 * 旧 enum reviewing/approved 已 migration 回填为 generated（migrate.ts 末尾 P0 段）。
 *
 * 设计要点：
 * - transitionStatus 用 UPDATE ... WHERE id=$1 AND status=$fromStatus 做 optimistic lock，
 *   命中 0 行视为 race / 状态被其他流程改过 → 抛 InvalidTransitionError(reason='race')。
 * - 进入 failed 写 error_message；其他成功转移清 error_message=NULL（避免旧错误残留）。
 * - 主入口 transitionStatus 只做 DB 写，不发事件 / 不写日志（caller 视场景加）。
 *   后续 WebSocket 实时推送在 P0 范围外，由 P1 加事件总线。
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { isAllowed, type ArticleStatus } from "./status-vocabulary.js";

/** P0-A2 user 强约束：error_message 不超过 500 字符（防超长 stacktrace 撑爆 DB / UI）。 */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

// 7-28 阶段1-B: 词表(状态全集 + 转移表 + isAllowed)已拆到零依赖的 status-vocabulary.ts,
// 让前端一致性守卫能直接 import 做真行为断言(不必再读源码正则)。这里原样再导出, 消费方零改动。
export type { ArticleStatus } from "./status-vocabulary.js";
export { ARTICLE_STATUSES, ALLOWED_TRANSITIONS, isAllowed } from "./status-vocabulary.js";

export class InvalidTransitionError extends Error {
  public readonly code = "INVALID_TRANSITION";

  constructor(
    public readonly fromStatus: ArticleStatus,
    public readonly toStatus: ArticleStatus,
    public readonly articleId: string,
    public readonly reason: "disallowed" | "race" | "not_found",
  ) {
    const reasonMsg =
      reason === "disallowed"
        ? `不允许从 ${fromStatus} 转到 ${toStatus}`
        : reason === "race"
          ? `状态机 race：期望 ${fromStatus} 但 DB 当前不是该状态`
          : `article 不存在`;
    super(`${reasonMsg}（id=${articleId}）`);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionOptions {
  /** 进入 failed 时写入 error_message；其他转移忽略此字段（一律清空 error_message）。 */
  errorMessage?: string | null;
}

/**
 * 把 article 状态从 fromStatus 改为 toStatus，原子 + optimistic lock。
 *
 * @throws InvalidTransitionError 转移不合法 / DB 当前 status ≠ fromStatus / id 不存在
 */
export async function transitionStatus(
  articleId: string,
  fromStatus: ArticleStatus,
  toStatus: ArticleStatus,
  opts: TransitionOptions = {},
): Promise<void> {
  if (!isAllowed(fromStatus, toStatus)) {
    throw new InvalidTransitionError(fromStatus, toStatus, articleId, "disallowed");
  }

  const now = new Date();
  // 进入 failed 截断到 500 字符；其他成功转移清空（避免旧错误残留）
  const rawError = toStatus === "failed" ? (opts.errorMessage ?? null) : null;
  const errorMessage =
    rawError && rawError.length > MAX_ERROR_MESSAGE_LENGTH
      ? rawError.slice(0, MAX_ERROR_MESSAGE_LENGTH)
      : rawError;

  const updated = await db
    .update(contents)
    .set({
      status: toStatus,
      statusUpdatedAt: now,
      errorMessage,
      updatedAt: now,
    })
    .where(and(eq(contents.id, articleId), eq(contents.status, fromStatus)))
    .returning({ id: contents.id });

  if (updated.length === 0) {
    // 区分 race vs not_found 需要再查一次；P0 简化为统一 race（caller 想区分自己查）
    logger.warn(
      { articleId, fromStatus, toStatus },
      "P0 state machine: optimistic lock miss（race or not_found）",
    );
    throw new InvalidTransitionError(fromStatus, toStatus, articleId, "race");
  }

  logger.info(
    { articleId, fromStatus, toStatus, hasError: errorMessage !== null },
    "P0 state machine: transit OK",
  );
}

/**
 * P0-A2 caller 友好辅助：先 SELECT 当前 status，再调 transitionStatus。
 *
 * 同状态自转（current === to）做 idempotent touch（仅刷 status_updated_at），
 * 避免 caller 多次调用同一目标状态时被 disallowed 抛错（spec 转移表严格不含自转）。
 *
 * @throws InvalidTransitionError 转移不合法（current ≠ fromStatus 任一）/ id 不存在
 */
export async function transitionToStatus(
  articleId: string,
  toStatus: ArticleStatus,
  opts: TransitionOptions = {},
): Promise<void> {
  const [row] = await db
    .select({ status: contents.status })
    .from(contents)
    .where(eq(contents.id, articleId))
    .limit(1);

  if (!row) {
    throw new InvalidTransitionError("draft", toStatus, articleId, "not_found");
  }

  const current = row.status as ArticleStatus;
  if (current === toStatus) {
    // idempotent touch：仅刷新 status_updated_at（spec INDEX 排序需要新数据）
    await db
      .update(contents)
      .set({ statusUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(contents.id, articleId));
    return;
  }

  await transitionStatus(articleId, current, toStatus, opts);
}

/**
 * P0-A2 INSERT 路径辅助：返回新建 article 的 status 字段集合。
 * 默认 'draft'（spec：createDraft → status='draft'）；caller 可覆盖（如内容直创建为 'generated'）。
 */
export function initialStatusFields(status: ArticleStatus = "draft"): {
  status: ArticleStatus;
  statusUpdatedAt: Date;
} {
  return { status, statusUpdatedAt: new Date() };
}
