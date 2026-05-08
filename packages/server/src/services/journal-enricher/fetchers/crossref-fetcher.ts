/**
 * Crossref fetcher（PR #107 期刊治理 PR 3 第 1 源）。
 *
 * 公开 JSON API，免授权（mailto for politeness 优先级）。
 * Endpoint: https://api.crossref.org/journals/{issn}
 * Returns: { status, message-type: "journal", message: { title, publisher, ISSN, counts, ... } }
 *
 * Crossref 基础元数据（title/publisher/ISSN/总 DOI 数）— 高可信，作为 ISSN 校验入口。
 * 失败 return null（partial OK，由 orchestrator 兜底）。
 */
import { logger } from "../../../config/logger.js";

const CROSSREF_BASE = "https://api.crossref.org/journals";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [500, 1500];

/** Crossref `message` 节内主要字段（按需取，含 partial 兼容）。 */
export interface CrossrefJournalRecord {
  title: string;
  publisher?: string;
  ISSN?: string[];
  "issn-type"?: Array<{ value: string; type: string }>;
  counts?: {
    "current-dois"?: number;
    "total-dois"?: number;
    "backfile-dois"?: number;
  };
  flags?: Record<string, boolean>;
  subjects?: Array<{ name: string; ASJC?: string }>;
}

/** ISSN 格式校验：XXXX-XXXX，最后位可为 X（校验码）。 */
function isValidIssn(issn: string): boolean {
  return /^\d{4}-\d{3}[\dXx]$/.test(issn);
}

export async function fetchCrossrefByIssn(
  issn: string | null | undefined,
  opts: { mailto?: string } = {},
): Promise<CrossrefJournalRecord | null> {
  if (!issn || typeof issn !== "string") return null;
  const cleaned = issn.trim();
  if (!cleaned) return null;

  if (!isValidIssn(cleaned)) {
    logger.debug({ issn: cleaned }, "Crossref: ISSN 格式不规范，跳过");
    return null;
  }

  const mailto = opts.mailto ?? "ops@boss-mates.com";
  const url = `${CROSSREF_BASE}/${cleaned}?mailto=${encodeURIComponent(mailto)}`;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          // Crossref polite pool：User-Agent 含联系方式
          "User-Agent": `BossMate-Enricher/0.1 (mailto:${mailto})`,
        },
      });
      clearTimeout(timer);

      if (resp.status === 404) {
        logger.debug({ issn: cleaned }, "Crossref: 期刊不存在（404）");
        return null;
      }
      if (!resp.ok) {
        throw new Error(`Crossref HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as {
        status?: string;
        "message-type"?: string;
        message?: CrossrefJournalRecord;
      };

      if (data.status !== "ok" || data["message-type"] !== "journal" || !data.message) {
        logger.warn({ issn: cleaned, status: data.status }, "Crossref: 响应格式异常");
        return null;
      }
      return data.message;
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
    "Crossref fetch 失败（已重试）",
  );
  return null;
}
