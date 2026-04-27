/**
 * 期刊封面图持久化 helper（T6-C）
 *
 * 用途：把"抓到了 cover URL，但还没回写 journals 表"的所有 inline 抓取路径统一到
 * 一个 idempotent UPDATE，避免重复实现/不一致 source 命名/race 覆盖已有 cover。
 *
 * 覆盖语义（idempotent）：
 *   UPDATE journals SET cover_image_url=?, cover_image_source=?,
 *     cover_fetched_at=NOW(), updated_at=NOW()
 *   WHERE id=? AND cover_image_url IS NULL
 *
 * - 已有 cover_image_url 的行不会被覆盖（WHERE 子句天然保证）
 * - 一次 SQL 完成，无 race
 * - 调用方拿到 { updated, reason } 区分"成功写入" / "已有 cover" / "未找到行" / "异常"
 *
 * 主流程不应被 cover 持久化失败阻塞 —— 任何异常都被 catch + warn log，
 * 调用方拿到 reason='error: ...' 自行判断是否需要追踪。
 */

import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export type PersistCoverResult =
  | { updated: true }
  | { updated: false; reason: "already_has_cover" | "journal_not_found" | string };

/**
 * 把抓到的 cover URL 回写到 journals.cover_image_url（仅当当前为空）。
 *
 * @param journalId journals.id
 * @param coverUrl 抓到的 cover URL
 * @param source 来源标识：'inline-skill' / 'inline-collector' / 'multi-source-backfill' 等
 */
export async function persistJournalCover(
  journalId: string,
  coverUrl: string,
  source: string
): Promise<PersistCoverResult> {
  if (!journalId || !coverUrl) {
    return { updated: false, reason: "journal_not_found" };
  }

  try {
    const result = await db
      .update(journals)
      .set({
        coverImageUrl: coverUrl,
        coverImageSource: source,
        coverFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(journals.id, journalId), isNull(journals.coverImageUrl)))
      .returning({ id: journals.id });

    if (result.length === 0) {
      // 0 行 affected：要么 id 不存在，要么 cover_image_url 已有值（被 WHERE 排除）
      const exists = await db
        .select({ id: journals.id })
        .from(journals)
        .where(eq(journals.id, journalId))
        .limit(1);
      if (exists.length === 0) {
        return { updated: false, reason: "journal_not_found" };
      }
      return { updated: false, reason: "already_has_cover" };
    }

    logger.debug({ journalId, source }, "journal cover persisted");
    return { updated: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ journalId, source, err: errMsg }, "persistJournalCover failed");
    return { updated: false, reason: `error: ${errMsg}` };
  }
}
