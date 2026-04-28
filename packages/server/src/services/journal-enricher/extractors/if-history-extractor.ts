/**
 * if_history extractor（B.2.1.A）
 *
 * Input: LetPubJournalDetail（来自 letpub-adapter）
 * Output: IfHistoryShape (jsonb 写 journals.if_history)
 *
 * Mapping:
 *   letpub.ifHistory: Array<{year, value}>  →  shape.data: Array<{year, if}>
 *
 * 注意 letpub 字段名是 "value"，本 enricher 用 "if"（贴 schema 字段名）。
 * 若 letpub 返回空数组 → 返回 null（不要写 {data:[]} 占位）。
 *
 * predicted 字段：B.2.1.A 不算（无 trend 模型），留给后续。
 */

import type { LetPubJournalDetail } from "../fetchers/letpub-adapter.js";
import type { IfHistoryShape } from "../types.js";

export function extractIfHistory(detail: LetPubJournalDetail | null): IfHistoryShape | null {
  if (!detail || !Array.isArray(detail.ifHistory) || detail.ifHistory.length === 0) {
    return null;
  }

  const data = detail.ifHistory
    .filter((row) => typeof row.year === "number" && typeof row.value === "number" && row.value > 0)
    .map((row) => ({ year: row.year, if: row.value }))
    .sort((a, b) => a.year - b.year);

  if (data.length === 0) return null;

  return {
    data,
    lastUpdatedAt: new Date().toISOString(),
  };
}
