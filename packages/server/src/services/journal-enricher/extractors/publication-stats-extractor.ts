/**
 * publication_stats extractor（B.2.1.A + B.2.1.B 扩展）
 *
 * Input: LetPubJournalDetail + JournalInfo（DB 已有的 frequency 字段）+ Scimago Top 5 机构
 * Output: PublicationStatsShape (jsonb 写 journals.publication_stats)
 *
 * Mapping:
 *   frequency = journal.frequency (DB existing) 优先
 *   annualVolumeHistory = letpub.pubVolumeHistory（同形 {year, count}）
 *   topInstitutions = Scimago HTML 抽出（B.2.1.B 新加）
 *
 * 三个子字段都没数据 → 返回 null
 */

import type { LetPubJournalDetail } from "../fetchers/letpub-adapter.js";
import type {
  PublicationStatsShape,
  AnnualVolumeRow,
  TopInstitutionRow,
} from "../types.js";

export interface PubStatsInput {
  letpub: LetPubJournalDetail | null;
  journalFrequency?: string | null;
  topInstitutions?: TopInstitutionRow[] | null; // B.2.1.B
}

export function extractPublicationStats(input: PubStatsInput): PublicationStatsShape | null {
  const { letpub, journalFrequency, topInstitutions } = input;

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

  const cleanedTopInstitutions =
    topInstitutions && topInstitutions.length > 0
      ? topInstitutions.filter((r) => typeof r.name === "string" && r.name.trim().length > 0)
      : undefined;

  if (
    !frequency &&
    !annualVolumeHistory &&
    (!cleanedTopInstitutions || cleanedTopInstitutions.length === 0)
  ) {
    return null;
  }

  return {
    frequency,
    annualVolumeHistory,
    topInstitutions:
      cleanedTopInstitutions && cleanedTopInstitutions.length > 0
        ? cleanedTopInstitutions
        : undefined,
    lastUpdatedAt: new Date().toISOString(),
  };
}
