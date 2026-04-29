/**
 * Stealth fetcher（B.2.1.B）—— puppeteer-extra-plugin-stealth
 *
 * 目的：绕过 Scimago / 部分期刊官网的 Cloudflare JS challenge。
 * 桌面 vanilla puppeteer 实测 Scimago 仍 403 ("请稍候…")，stealth plugin 必需。
 *
 * 实现要点：
 *  - 单例 browser pool（与 video/html-renderer 不共享，避免插件全局污染 video skill）
 *  - launch 配置复用 video/html-renderer 的 args（无 sandbox / no GPU 等）
 *  - 失败重试 2 次（exponential backoff 1s → 2s）
 *  - 连续 ≥3 次失败抛 STEALTH_FAIL_STREAK 错误（worker 层兜底）
 */

import puppeteerExtraImport from "puppeteer-extra";
import StealthPluginImport from "puppeteer-extra-plugin-stealth";
import type { Browser } from "puppeteer";
import { logger } from "../../../../config/logger.js";

// puppeteer-extra / stealth ship CJS default export with TS shape mismatch under
// "module: NodeNext" — unwrap interop default if present.
const puppeteerExtra: any =
  (puppeteerExtraImport as any)?.default ?? puppeteerExtraImport;
const StealthPlugin: () => any =
  (StealthPluginImport as any)?.default ?? StealthPluginImport;

puppeteerExtra.use(StealthPlugin());

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
];

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let consecutiveFailures = 0;
export const MAX_STEALTH_FAIL_STREAK = 3;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  if (launching) return launching;
  launching = (async () => {
    const b = (await puppeteerExtra.launch({ headless: true, args: LAUNCH_ARGS })) as unknown as Browser;
    logger.info("stealth puppeteer 启动完成");
    b.on("disconnected", () => {
      logger.warn("stealth puppeteer disconnected");
      browser = null;
    });
    browser = b;
    return b;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

export interface StealthFetchOptions {
  /** 等待选择器（页面加载后等到该元素出现才算成功） */
  waitFor?: string;
  /** 整个 navigation 超时 ms（默认 30000） */
  timeout?: number;
}

/**
 * Stealth 抓取 URL，返回 fully-rendered HTML。
 * 失败 return null（不抛错），连续 ≥3 失败抛 streak 错由 worker 层兜底。
 * Exported for unit testing.
 */
export async function fetchWithStealth(
  url: string,
  options: StealthFetchOptions = {},
): Promise<string | null> {
  if (consecutiveFailures >= MAX_STEALTH_FAIL_STREAK) {
    throw new Error(
      `STEALTH_FAIL_STREAK: 连续 ${consecutiveFailures} 次 stealth-fetch 失败，疑似 Cloudflare 升级或 IP 拉黑，停止 stealth 调用。重启服务重置。`,
    );
  }
  const timeout = options.timeout ?? 30000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const b = await getBrowser();
      const page = await b.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout });
        if (options.waitFor) {
          await page.waitForSelector(options.waitFor, { timeout: Math.min(timeout, 15000) });
        }
        // 简单 challenge 检测：title 含 "Just a moment" / "请稍候" → CF 仍未通过。
        // Cloudflare 的 interstitial 页通常 3-8 秒后 JS 自动跳转到目标页（stealth 已绕过 fingerprint）。
        // 这里 polling 等 title 变化（最多 12s），变了再 reload network-idle 抓最终 HTML。
        const challengeRe = /Just a moment|请稍候|Attention Required/i;
        let title = await page.title();
        if (challengeRe.test(title)) {
          const waitDeadline = Date.now() + 12000;
          while (Date.now() < waitDeadline && challengeRe.test(title)) {
            await new Promise((r) => setTimeout(r, 800));
            title = await page.title().catch(() => title);
          }
        }
        if (challengeRe.test(title)) {
          throw new Error(`CF challenge not passed (title="${title}")`);
        }
        // challenge 通过后再等一次 network idle，确保目标页 DOM 完整
        try {
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 });
        } catch {
          // 没二次跳转也 OK，继续读 content
        }
        const html = await page.content();
        consecutiveFailures = 0;
        return html;
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      logger.warn(
        { url, attempt, err: err instanceof Error ? err.message : String(err) },
        "stealth fetch attempt failed",
      );
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * attempt)); // 1s → 2s exp backoff
      }
    }
  }
  consecutiveFailures += 1;
  logger.warn({ url, streak: consecutiveFailures }, "stealth fetch returned null after retries");
  return null;
}

/** Exported for tests / admin reset */
export function resetStealthFailStreak(): void {
  consecutiveFailures = 0;
}

/** Exported for tests */
export function _getStealthFailStreak(): number {
  return consecutiveFailures;
}

export async function closeStealthBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
    browser = null;
  }
}
