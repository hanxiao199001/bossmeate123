/**
 * OpenAlex fetcher (B.2.1.B.2)
 *
 * 主路径替代 PR #34 stealth fetcher（数据中心 IP CF 屏蔽现实）。
 * OpenAlex 是公开 API，0 反爬 + 10K req/day 免费 polite-pool（带 mailto）。
 *
 * 提供两个端点封装：
 *   1. fetchOpenAlexJournal(issn): 拿 source 详情（含 topics / topic_share /
 *      apc_usd / host_organization_name 等）。带 ISSN 严格 guard 防 silent 错配。
 *   2. fetchOpenAlexTopInstitutions(sourceId, opts): group_by 机构聚合 Top N。
 */

import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";

const OPENALEX_BASE = "https://api.openalex.org";
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_BACKOFF_MS = [500, 1500];

// ============ 类型 ============

export interface OpenAlexTopic {
  id?: string;
  display_name?: string;
  count?: number;
  subfield?: { id?: string; display_name?: string };
  field?: { id?: string; display_name?: string };
  domain?: { id?: string; display_name?: string };
}

export interface OpenAlexTopicShare {
  id?: string;
  display_name?: string;
  value?: number;
  subfield?: { display_name?: string };
  field?: { display_name?: string };
}

export interface OpenAlexSource {
  id: string;
  display_name?: string;
  issn_l?: string | null;
  issn?: string[] | null;
  host_organization?: string | null;
  host_organization_name?: string | null;
  homepage_url?: string | null;
  is_oa?: boolean;
  is_in_doaj?: boolean;
  apc_usd?: number | null;
  apc_prices?: Array<{ price: number; currency: string }> | null;
  topics?: OpenAlexTopic[];
  topic_share?: OpenAlexTopicShare[];
  works_count?: number;
  works_api_url?: string;
}

export interface OpenAlexInstitutionRow {
  /** OpenAlex institution ID (URL form) */
  key: string;
  /** Display name */
  key_display_name: string;
  /** Paper count */
  count: number;
}

export interface FetchTopInstitutionsOptions {
  /** ISO 3166-1 alpha-2 country code, e.g. "cn" — only include institutions in that country */
  country?: string;
  /** per_page (1-200), default 10 */
  limit?: number;
}

// ============ Helpers ============

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${OPENALEX_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  if (env.OPENALEX_MAILTO) url.searchParams.set("mailto", env.OPENALEX_MAILTO);
  return url.toString();
}

async function fetchJsonWithRetry(url: string, label: string): Promise<any | null> {
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "BossMate-Enricher/0.1 (+https://bossmate.com)" },
      });
      clearTimeout(timer);
      if (resp.ok) return await resp.json();
      if (resp.status >= 400 && resp.status < 500) {
        // 4xx (404/410 等)：不重试，return null（partial OK）
        logger.warn({ url, status: resp.status, label }, "OpenAlex 4xx — 不重试");
        return null;
      }
      // 5xx fallthrough to retry
      logger.warn({ url, status: resp.status, attempt, label }, "OpenAlex 5xx — 重试");
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url, attempt, label, err: msg }, "OpenAlex 请求异常");
    }
    const backoff = RETRY_BACKOFF_MS[attempt];
    if (backoff !== undefined) {
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return null;
}

/** 严格 ISSN match：source.issn_l 等于 input 或 source.issn[] 含 input。Exported for tests. */
export function issnMatches(source: { issn_l?: string | null; issn?: string[] | null }, input: string): boolean {
  const target = input.trim();
  if (!target) return false;
  if (source.issn_l && source.issn_l === target) return true;
  if (Array.isArray(source.issn) && source.issn.includes(target)) return true;
  return false;
}

// ============ Public API ============

/**
 * 通过 ISSN 在 OpenAlex 找期刊 source 详情（pre-fetch verify ISSN）。
 * 严格 guard: 第 1 个 hit 的 issn_l/issn 必须含输入 ISSN，否则 return null。
 */
export async function fetchOpenAlexJournal(issn: string | null): Promise<OpenAlexSource | null> {
  if (!issn || !issn.trim()) {
    logger.debug("OpenAlex fetcher: ISSN 缺失，跳过");
    return null;
  }
  const issnTrim = issn.trim();
  // OpenAlex `search` 参数只搜文本字段（不搜 ISSN）。必须用 filter=issn:xxx 才行。
  // 接受带或不带连字符的 ISSN 输入，OpenAlex 会做 normalize。
  const searchUrl = buildUrl("/sources", { filter: `issn:${issnTrim}`, per_page: "5" });
  const searchRes = await fetchJsonWithRetry(searchUrl, "openalex.sources.filter");
  if (!searchRes || !Array.isArray(searchRes.results) || searchRes.results.length === 0) {
    logger.debug({ issn: issnTrim }, "OpenAlex: 0 search results");
    return null;
  }
  // ISSN 严格 guard: 找第 1 个真正命中的 source；否则 null（不要 silent 取 first hit）
  const matched = searchRes.results.find((r: any) => issnMatches(r, issnTrim));
  if (!matched) {
    logger.warn(
      { issn: issnTrim, firstResult: searchRes.results[0]?.id, firstIssnL: searchRes.results[0]?.issn_l },
      "OpenAlex: search hit 但 ISSN 不严格匹配，guard 拒绝",
    );
    return null;
  }
  return matched as OpenAlexSource;
}

/**
 * 从 source.id（如 https://openalex.org/S49861241 或 S49861241）拉 Top N 投稿机构。
 */
export async function fetchOpenAlexTopInstitutions(
  sourceId: string,
  opts: FetchTopInstitutionsOptions = {},
): Promise<OpenAlexInstitutionRow[] | null> {
  const idShort = sourceId.replace(/^https?:\/\/openalex\.org\//, "");
  if (!/^S\d+$/.test(idShort)) {
    logger.warn({ sourceId }, "OpenAlex Top Institutions: sourceId 非法");
    return null;
  }
  const filters = [`primary_location.source.id:${idShort}`];
  if (opts.country) filters.push(`authorships.institutions.country_code:${opts.country.toLowerCase()}`);
  const url = buildUrl("/works", {
    filter: filters.join(","),
    group_by: "authorships.institutions.id",
    per_page: String(Math.min(opts.limit ?? 10, 50)),
  });
  const res = await fetchJsonWithRetry(url, "openalex.works.group_by.institutions");
  if (!res || !Array.isArray(res.group_by)) return null;
  return res.group_by as OpenAlexInstitutionRow[];
}
