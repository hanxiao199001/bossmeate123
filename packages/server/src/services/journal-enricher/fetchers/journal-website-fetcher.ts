/**
 * Journal-website fetcher (B.2.1.B)
 *
 * 通过 stealth 抓取期刊官网（通常是 publisher 提供的 SPA：Cell Press / Elsevier /
 * Springer / Nature / 等）。期刊官网 ≠ Scimago：多数没有 CF challenge，但有
 * 部分（Wiley、IEEE 等）会 bot-check，stealth 一并兼容。
 *
 * 输入是 journal.website（DB schema.ts:212）；空 URL 直接 return null。
 * 抓回完整 HTML，由 LLM extractor 切窗口提取 scope / APC。
 */

import { fetchWithStealth } from "./shared/stealth-fetcher.js";
import { logger } from "../../../config/logger.js";

export interface JournalWebsiteFetchInput {
  websiteUrl: string | null;
}

export async function fetchJournalWebsite(
  input: JournalWebsiteFetchInput,
): Promise<string | null> {
  if (!input.websiteUrl || !/^https?:\/\//i.test(input.websiteUrl)) {
    logger.debug({ url: input.websiteUrl }, "Journal website fetcher: URL 缺失/不合法，跳过");
    return null;
  }
  try {
    const html = await fetchWithStealth(input.websiteUrl, {
      waitFor: "body",
      timeout: 30000,
    });
    if (!html) return null;
    return html;
  } catch (err) {
    logger.warn(
      { url: input.websiteUrl, err: err instanceof Error ? err.message : String(err) },
      "Journal website fetch error",
    );
    return null;
  }
}
