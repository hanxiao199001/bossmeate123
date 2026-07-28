/**
 * 内容状态词表 —— **全系统唯一真相源**(纯数据, 零 IO 零依赖)。
 *
 * 7-28 阶段1-B: 原本这三样东西长在 `state-machine.ts` 里, 而那个文件 import 了 db/schema/logger。
 * 结果是"想知道合法状态有哪些"就必须把数据库连接一起拖进来 —— 前端的一致性守卫因此无法 import,
 * 只能退化成读源码正则匹配(框架里点名要淘汰的第 4 类测试)。
 * 拆出来之后: 词表可被任何一侧直接 import 做真行为断言, state-machine 原样再导出, 消费方零改动。
 *
 * ⚠️ 改这里 = 改值域。必须同步:
 *   1. `apps/web/src/utils/i18n.ts` 的 ARTICLE_STATUSES + 三张 Record<ArticleStatus,…> 表
 *      (由 apps/web/src/utils/cross-end-vocabulary.test.ts 守着)
 *   2. `models/schema.ts` contents.status 的注释
 *   3. 阶段3 会加的 DB CHECK 约束
 */

export type ArticleStatus =
  | "draft"
  | "generating"
  | "failed"
  | "generated"
  | "needs_review"   // PR-U2: 质检未过, 待人工复核(不可直接发)
  | "published"
  | "archived";

export const ARTICLE_STATUSES: readonly ArticleStatus[] = [
  "draft",
  "generating",
  "failed",
  "generated",
  "needs_review",
  "published",
  "archived",
] as const;

/**
 * 合法状态转移表：key=fromStatus，value=允许的 toStatus 列表。
 * 不在列表的转移会被 transitionStatus 拒绝（InvalidTransitionError reason='disallowed'）。
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ArticleStatus, readonly ArticleStatus[]>> = {
  draft: ["generating", "archived"],
  generating: ["generated", "failed", "needs_review"], // PR-U2: 质检未过 → needs_review
  failed: ["generating", "archived"], // 重试 / 放弃
  generated: ["published", "draft", "archived"], // 发布 / 回退编辑 / 归档
  needs_review: ["generated", "draft", "archived"], // 人工采用 / 退回编辑 / 弃
  published: ["archived"],
  archived: [],
} as const;

/** 纯函数：判断转移是否合法（不查 DB）。 */
export function isAllowed(from: ArticleStatus, to: ArticleStatus): boolean {
  const next = ALLOWED_TRANSITIONS[from];
  return Array.isArray(next) && next.includes(to);
}
