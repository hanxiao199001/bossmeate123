/**
 * PR Q.1：按公众号名批量抓取文章（行业样板用，喂 LanceDB industry_sample 仓供 few-shot）。
 *
 * 设计：sogou 微信搜索（https://weixin.sogou.com/weixin?type=2&query={name}）→ 文章列表
 * → 顺序 fetch 每篇 mp.weixin.qq.com 文章页 → 解析 title/body/published/read_count。
 *
 * 反爬策略：
 * 1. UA 轮换（5 个 desktop UA 随机）
 * 2. 单次请求超时 10s + 失败 5min 退避
 * 3. 验证码命中（response 含 "verify" 关键字 / 302 redirect 到 antispider）→ log warn 跳过
 * 4. scrapling fallback：若服务器装了 scrapling 则可二级 stealth fetch（5-6 早 user 拍是否 pip install）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../config/logger.js";

const execFileAsync = promisify(execFile);
const SCRAPLING_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/wechat_fetch.py",
);

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

export interface CrawledArticle {
  url: string;
  title: string;
  body: string;             // 纯文本正文（已剥 html）
  publishedAt: Date | null;
  readCount: number | null;
  account: string;
}

export interface CrawlOptions {
  maxArticles?: number;       // 默认 20
  minPublishedAt?: Date;      // 截止时间下限（默认 90 天前）
  fetchTimeoutMs?: number;    // 默认 10000
}

function pickUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

/** PR Q.1.1: scrapling stealth fetch fallback（突破 sogou 跳转层反爬）。*/
async function fetchHtmlScrapling(url: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("python3", [SCRAPLING_SCRIPT, url], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!stdout || stdout.length < 200) return null;
    if (stdout.includes("antispider") || stdout.includes("/verify?")) return null;
    return stdout;
  } catch (err) {
    logger.warn({ url, err: err instanceof Error ? err.message : err }, "wechat-batch: scrapling fallback failed");
    return null;
  }
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": pickUA(), "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "wechat-batch: fetch non-OK，转 scrapling");
      return fetchHtmlScrapling(url);
    }
    const text = await res.text();
    if (text.includes("antispider") || text.includes("/verify?") || text.length < 200) {
      logger.warn({ url, len: text.length }, "wechat-batch: 疑似反爬响应，转 scrapling");
      return fetchHtmlScrapling(url);
    }
    return text;
  } catch (err) {
    logger.warn({ url, err: err instanceof Error ? err.message : err }, "wechat-batch: 标准 fetch 失败，转 scrapling");
    return fetchHtmlScrapling(url);
  } finally {
    clearTimeout(timer);
  }
}

/** 从 sogou 搜索结果页提取文章 url 列表（最多 maxArticles 篇）。 */
function parseSogouSearchResults(html: string, max: number): string[] {
  const urls: string[] = [];
  // sogou 用 a.title-link href 跳转到 mp.weixin.qq.com，但实际 wrap 在 sogou 跳转 url 里。
  // 简单匹配 https://mp.weixin.qq.com/s?__biz=... 的直链或 sogou link 反查。
  const re = /href="([^"]*?(?:mp\.weixin\.qq\.com\/s[^"]+|\/link\?url=[^"]+))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && urls.length < max) {
    const u = m[1].replace(/&amp;/g, "&");
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

/** 从 mp.weixin.qq.com 文章页解析 title / body / published_at / read_count。 */
function parseArticlePage(html: string): Pick<CrawledArticle, "title" | "body" | "publishedAt" | "readCount"> | null {
  const titleMatch = html.match(/<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : null;
  if (!title) return null;
  const bodyMatch = html.match(/<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
  const body = bodyMatch
    ? bodyMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : "";
  const dateMatch = html.match(/var publish_time\s*=\s*"([^"]+)"/) || html.match(/var\s+ct\s*=\s*"(\d+)"/);
  const publishedAt = dateMatch
    ? (/^\d+$/.test(dateMatch[1]) ? new Date(parseInt(dateMatch[1], 10) * 1000) : new Date(dateMatch[1]))
    : null;
  const readMatch = html.match(/"read_num":(\d+)/);
  const readCount = readMatch ? parseInt(readMatch[1], 10) : null;
  return { title, body, publishedAt, readCount };
}

export async function crawlWechatAccount(
  accountName: string,
  opts: CrawlOptions = {},
): Promise<CrawledArticle[]> {
  const max = opts.maxArticles ?? 20;
  const cutoff = opts.minPublishedAt ?? new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const timeout = opts.fetchTimeoutMs ?? 10000;
  const searchUrl = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(accountName)}`;

  const searchHtml = await fetchHtml(searchUrl, timeout);
  if (!searchHtml) {
    logger.warn({ accountName }, "wechat-batch: sogou 搜索失败（反爬或网络），返回空");
    return [];
  }

  const articleUrls = parseSogouSearchResults(searchHtml, max * 2); // 多取一些为去重 + 过期 buffer
  logger.info({ accountName, candidateCount: articleUrls.length }, "wechat-batch: 找到候选文章 url");

  const out: CrawledArticle[] = [];
  for (const url of articleUrls) {
    if (out.length >= max) break;
    const html = await fetchHtml(url.startsWith("http") ? url : `https://weixin.sogou.com${url}`, timeout);
    if (!html) continue;
    const parsed = parseArticlePage(html);
    if (!parsed) continue;
    if (parsed.publishedAt && parsed.publishedAt < cutoff) continue;
    if (parsed.body.length < 200) continue;  // 太短可能是封面/重定向
    out.push({ url, account: accountName, ...parsed });
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000)); // 1-2s 随机间隔避免反爬
  }
  logger.info({ accountName, crawled: out.length }, "wechat-batch: 抓取完成");
  return out;
}
