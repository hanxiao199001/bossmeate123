/**
 * DOAJ fetcher（B.2.1.A）
 *
 * Directory of Open Access Journals 公开 JSON API，免授权。
 * 只查 OA 期刊；非 OA 期刊查不到 → 返回 null（不报错）。
 *
 * Endpoint: https://doaj.org/api/search/journals/issn:{issn}
 * Returns: { results: [{ id, bibjson: {...} }, ...], total, ... }
 *
 * 反爬：DOAJ 是公益站点，不需要 UA 伪装。
 * 重试：2 次，超时 10s/次。
 */

import { logger } from "../../../config/logger.js";
import type { DoajJournalRecord } from "../types.js";

const DOAJ_BASE = "https://doaj.org/api/search/journals";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [500, 1500];

export async function fetchDoajByIssn(issn: string | null | undefined): Promise<DoajJournalRecord | null> {
  if (!issn || typeof issn !== "string") return null;
  const cleaned = issn.trim();
  if (!cleaned) return null;

  // ISSN 格式校验（XXXX-XXXX 8 字符 / 含 1 个连字符）
  if (!/^\d{4}-\d{3}[\dXx]$/.test(cleaned)) {
    logger.debug({ issn: cleaned }, "DOAJ fetcher: ISSN 格式不规范，跳过");
    return null;
  }

  const url = `${DOAJ_BASE}/issn:${cleaned}`;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);

      if (resp.status === 404) {
        logger.debug({ issn: cleaned }, "DOAJ: 非 OA 期刊（404 not in DOAJ）");
        return null;
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { results?: unknown };
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) {
        logger.debug({ issn: cleaned }, "DOAJ: 0 results（非 OA 或未收录）");
        return null;
      }
      return results[0] as DoajJournalRecord;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
  }

  logger.warn(
    { issn: cleaned, err: lastErr instanceof Error ? lastErr.message : String(lastErr) },
    "DOAJ fetch failed after retries"
  );
  return null;
}
