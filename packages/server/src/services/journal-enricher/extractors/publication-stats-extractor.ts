/**
 * publication_stats extractor（B.2.1.A）
 *
 * Input: LetPubJournalDetail + JournalInfo（DB 已有的 frequency 字段）
 * Output: PublicationStatsShape (jsonb 写 journals.publication_stats)
 *
 * 本 PR 只填 frequency + annualVolumeHistory；topInstitutions 留 B.2.1.B。
 *
 * Mapping:
 *   frequency = journal.frequency (DB existing) 优先
 *   annualVolumeHistory = letpub.pubVolumeHistory（同形 {year, count}）
 *
 * 两个子字段都没数据 → 返回 null
 */

import type { LetPubJournalDetail } from "../fetchers/letpub-adapter.js";
import type { PublicationStatsShape, AnnualVolumeRow } from "../types.js";

export interface PubStatsInput {
  letpub: LetPubJournalDetail | null;
  journalFrequency?: string | null;
}

export function extractPublicationStats(input: PubStatsInput): PublicationStatsShape | null {
  const { letpub, journalFrequency } = input;

  const frequency = journalFrequency && typeof journalFrequency === "string"
    ? journalFrequency.trim() || undefined
    : undefined;

  let annualVolumeHistory: AnnualVolumeRow[] | undefined;
  if (letpub && Array.isArray(letpub.pubVolumeHistory) && letpub.pubVolumeHistory.length > 0) {
    const rows = letpub.pubVolumeHistory
      .filter((r) => typeof r.year === "number" && typeof r.count === "number" && r.count >= 0)
      .map((r) => ({ year: r.year, count: r.count }))
      .sort((a, b) => a.year - b.year);
    if (rows.length > 0) annualVolumeHistory = rows;
  }

  if (!frequency && !annualVolumeHistory) return null;

  return {
    frequency,
    annualVolumeHistory,
    lastUpdatedAt: new Date().toISOString(),
  };
}
