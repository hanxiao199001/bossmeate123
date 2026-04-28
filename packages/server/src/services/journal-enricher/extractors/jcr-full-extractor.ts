/**
 * jcr_full extractor（B.2.1.A）
 *
 * Input: LetPubJournalDetail
 * Output: JcrFullShape (jsonb 写 journals.jcr_full)
 *
 * Mapping:
 *   wosLevel = jcrPartitions[0]?.database  (e.g., "SCIE")
 *              如果多条且不一致，取出现频次最高的（生产中通常一致）
 *   jifSubjects = jcrPartitions.map(p => {subject, zone, rank, database})
 *   jciSubjects = jciPartitions.map(同上)
 *   isTopJournal = casPartitions.some(p => p.isTop)
 *   isReviewJournal = casPartitions.some(p => p.isReview)
 *
 * 全部维度都缺 → 返回 null。
 */

import type { LetPubJournalDetail } from "../fetchers/letpub-adapter.js";
import type { JcrFullShape, JcrSubjectEntry } from "../types.js";

export function extractJcrFull(detail: LetPubJournalDetail | null): JcrFullShape | null {
  if (!detail) return null;

  const jifSubjects: JcrSubjectEntry[] = (detail.jcrPartitions || [])
    .filter((p) => p && typeof p.subject === "string")
    .map((p) => ({
      subject: p.subject,
      zone: p.zone || undefined,
      rank: p.rank || undefined,
      database: p.database || undefined,
    }));

  const jciSubjects: JcrSubjectEntry[] = (detail.jciPartitions || [])
    .filter((p) => p && typeof p.subject === "string")
    .map((p) => ({
      subject: p.subject,
      zone: p.zone || undefined,
      rank: p.rank || undefined,
      database: p.database || undefined,
    }));

  // wosLevel: 取 jcrPartitions 里出现频次最高的 database
  let wosLevel: string | undefined;
  if (jifSubjects.length > 0) {
    const counts = new Map<string, number>();
    for (const s of jifSubjects) {
      if (s.database) counts.set(s.database, (counts.get(s.database) || 0) + 1);
    }
    if (counts.size > 0) {
      wosLevel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  const isTopJournal = (detail.casPartitions || []).some((p) => p && p.isTop === true);
  const isReviewJournal = (detail.casPartitions || []).some((p) => p && p.isReview === true);

  // 全维度都没有 → 视为无 jcr_full 数据
  if (
    !wosLevel &&
    jifSubjects.length === 0 &&
    jciSubjects.length === 0 &&
    !isTopJournal &&
    !isReviewJournal
  ) {
    return null;
  }

  return {
    wosLevel,
    jifSubjects: jifSubjects.length > 0 ? jifSubjects : undefined,
    jciSubjects: jciSubjects.length > 0 ? jciSubjects : undefined,
    isTopJournal,
    isReviewJournal,
    lastUpdatedAt: new Date().toISOString(),
  };
}
