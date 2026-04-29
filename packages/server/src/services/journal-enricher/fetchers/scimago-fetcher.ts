/**
 * Scimago fetcher (B.2.1.B)
 *
 * Scimago 由 Cloudflare JS challenge 保护（实测 axios/curl/vanilla puppeteer 全 403）。
 * 必须走 stealth。Search URL 模式：
 *   https://www.scimagojr.com/journalsearch.php?q={ISSN}
 *
 * 返回 fully-rendered HTML（已通过 CF challenge）。失败 return null，由 orchestrator 走 partial OK。
 */

import { fetchWithStealth } from "./shared/stealth-fetcher.js";
import { logger } from "../../../config/logger.js";

const SCIMAGO_BASE = "https://www.scimagojr.com";

export interface ScimagoFetchInput {
  issn: string | null;
}

export async function fetchScimagoByIssn(input: ScimagoFetchInput): Promise<string | null> {
  if (!input.issn) {
    logger.debug("Scimago fetcher: ISSN 缺失，跳过");
    return null;
  }
  // Scimago 接受带或不带连字符的 ISSN，原样传
  const url = `${SCIMAGO_BASE}/journalsearch.php?q=${encodeURIComponent(input.issn)}`;
  try {
    // 等首条结果链接出现 — Scimago search 结果有 .search_results 或 a[href*="journalsearch.php?q="]
    const html = await fetchWithStealth(url, { waitFor: "body", timeout: 30000 });
    if (!html) return null;
    return html;
  } catch (err) {
    // STEALTH_FAIL_STREAK 抛出由 orchestrator 兜底
    logger.warn(
      { issn: input.issn, err: err instanceof Error ? err.message : String(err) },
      "Scimago fetch error",
    );
    return null;
  }
}
