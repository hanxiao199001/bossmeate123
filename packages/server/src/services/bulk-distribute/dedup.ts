/**
 * 6-19 收口: 发布去重单一实现 — 自动分发(auto-distribute)与手动批量(/bulk-distribute)共用。
 * 之前两处各写一份相同的 "查 content_publish_log 已成功 (content,account) 并剔除" 逻辑,
 * 改一处易漏另一处。统一到这里: 传入配对, 拆成 fresh(没发过) / skipped(已发过)。
 */
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";

export interface DedupPair {
  contentId: string;
  accountId: string;
}

/**
 * 按 content_publish_log 里 status='success' 的 (content_id, account_id) 唯一去重。
 * 返回 { fresh, skipped }; 调用方自行决定 skipped 要不要落 'skipped' 日志(手动批量会落, 自动分发不落)。
 * 泛型透传原始配对对象(可带 discipline 等额外字段), 只要求每项有 contentId + accountId。
 */
export async function splitAlreadyPublished<T extends DedupPair>(
  pairs: T[],
): Promise<{ fresh: T[]; skipped: T[] }> {
  if (pairs.length === 0) return { fresh: [], skipped: [] };
  const tuples = pairs.map((p) => sql`(${p.contentId}::uuid, ${p.accountId}::uuid)`);
  const res = await db.execute(sql`
    SELECT content_id, account_id FROM content_publish_log
    WHERE status = 'success' AND (content_id, account_id) IN (${sql.join(tuples, sql`, `)})
  `);
  const done = new Set(
    ((res as any).rows as Array<{ content_id: string; account_id: string }>).map(
      (r) => `${r.content_id}|${r.account_id}`,
    ),
  );
  const fresh: T[] = [];
  const skipped: T[] = [];
  for (const p of pairs) {
    (done.has(`${p.contentId}|${p.accountId}`) ? skipped : fresh).push(p);
  }
  return { fresh, skipped };
}
