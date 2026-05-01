/**
 * 万方期刊详情页 fetcher（B.4-2）。
 *
 * 数据源：med.wanfangdata.com.cn/Periodical/Detail/{perioId}（限医学子域 SSR）
 * 主站 c.wanfangdata.com.cn 是 SPA 空 div 不可用，必须走 med 子域。
 *
 * 互补策略：B.4-1 静态 17 条 + 本 fetcher 动态补 29 条 = 46 条全 cover。
 * cscdLevel / pkuCoreLevel NULL 才填（保留 B.4-1 静态权威源），不覆盖。
 *
 * 反爬：
 *   - UA 池 3 个真实 Chrome / Edge / Safari 轮换
 *   - Referer = baidu.com（站外友好）
 *   - 节流复用 BullMQ B.3 throttle（concurrency=1, delayMs=10s±3s）
 *   - 失败 retry 2 次，5xx / 网络异常重试，4xx 不重试 return null
 */
import { logger } from "../../../config/logger.js";

const WANFANG_BASE = "https://med.wanfangdata.com.cn";
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_BACKOFF_MS = [800, 2000];

const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];

function pickUa(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

async function fetchHtmlWithRetry(url: string, label: string): Promise<string | null> {
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": pickUa(),
          Referer: "https://www.baidu.com/",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        },
      });
      clearTimeout(timer);
      if (resp.ok) return await resp.text();
      if (resp.status >= 400 && resp.status < 500) {
        // 4xx (404/410)：不重试，return null（partial OK，期刊不在万方收录）
        logger.warn({ url, status: resp.status, label }, "wanfang 4xx — 不重试");
        return null;
      }
      logger.warn({ url, status: resp.status, attempt, label }, "wanfang 5xx — 重试");
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url, attempt, label, err: msg }, "wanfang 请求异常");
    }
    const backoff = RETRY_BACKOFF_MS[attempt];
    if (backoff !== undefined) await new Promise((r) => setTimeout(r, backoff));
  }
  return null;
}

/** 万方 perioId 通常 = 中文刊名拼音首字母缩写（zhyx = 中华医学杂志），需手工 / 反查映射。 */
export interface WanfangFetchInput {
  /** 优先用 perioId（最稳）；无则尝试 issn 反查 */
  perioId?: string | null;
  issn?: string | null;
  /** 中文刊名（debug log 用，反查 fallback 不实施 v1） */
  nameZh?: string | null;
}

export interface WanfangFetchResult {
  /** 详情页 raw HTML（cheerio 在 extractor 解析） */
  html: string;
  /** 实际命中的 perioId */
  perioId: string;
  /** 来源 URL（debug） */
  url: string;
}

/**
 * 通过 perioId 直接抓详情页。v1 不实现 ISSN→perioId 反查（万方无公开搜索 API），
 * 由 admin 在 journals 表 metadata.wanfang.perioId 预先填好（B.4-2 trial 阶段
 * 5-10 条手动 verify 时人工标注）。
 */
export async function fetchWanfangPeriodical(
  input: WanfangFetchInput,
): Promise<WanfangFetchResult | null> {
  const perioId = (input.perioId ?? "").trim();
  if (!perioId) {
    logger.debug({ input }, "wanfang fetcher: perioId 缺失，跳过（v1 不做 ISSN 反查）");
    return null;
  }
  // 防注入：perioId 仅允许 [a-z0-9_-]+
  if (!/^[a-z0-9_-]+$/i.test(perioId)) {
    logger.warn({ perioId }, "wanfang fetcher: perioId 非法字符，拒绝");
    return null;
  }
  const url = `${WANFANG_BASE}/Periodical/Detail/${perioId}`;
  const html = await fetchHtmlWithRetry(url, "wanfang.periodical.detail");
  if (!html) return null;
  // 简单 sanity check：HTML 长度 < 5KB 多半是空页 / 错误页
  if (html.length < 5000) {
    logger.warn({ url, htmlLen: html.length }, "wanfang HTML 过小，疑似空页");
    return null;
  }
  return { html, perioId, url };
}
