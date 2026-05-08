/**
 * P0：article lifecycle state machine（5-9 / 5-10 工期）。
 *
 * 6 个状态：draft → generating → (generated | failed) → published → archived
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

export type ArticleStatus =
  | "draft"
  | "generating"
  | "failed"
  | "generated"
  | "published"
  | "archived";

export const ARTICLE_STATUSES: readonly ArticleStatus[] = [
  "draft",
  "generating",
  "failed",
  "generated",
  "published",
  "archived",
] as const;

/**
 * 合法状态转移表：key=fromStatus，value=允许的 toStatus 列表。
 * 不在列表的转移会被 transitionStatus 拒绝（InvalidTransitionError reason='disallowed'）。
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ArticleStatus, readonly ArticleStatus[]>> = {
  draft: ["generating", "archived"],
  generating: ["generated", "failed"],
  failed: ["generating", "archived"], // 重试 / 放弃
  generated: ["published", "draft", "archived"], // 发布 / 回退编辑 / 归档
  published: ["archived"],
  archived: [],
} as const;

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

/** 纯函数：判断转移是否合法（不查 DB）。 */
export function isAllowed(from: ArticleStatus, to: ArticleStatus): boolean {
  const next = ALLOWED_TRANSITIONS[from];
  return Array.isArray(next) && next.includes(to);
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
  const errorMessage = toStatus === "failed" ? (opts.errorMessage ?? null) : null;

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
