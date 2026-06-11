/**
 * 本地有头浏览器管理 — 每账号持久 profile (userDataDir 落盘):
 * 扫码与推送同一浏览器环境, 登录态原生在磁盘上, 不做 cookie 移植
 * (抖音 cookie 移植必被风控踢 — server browser-session.ts 实测结论)。
 */
import puppeteerExtraImport from "puppeteer-extra";
import StealthPluginImport from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { mkdir } from "node:fs/promises";
import { profileDir } from "./config.js";
import { logger } from "./log.js";

// CJS interop unwrap — 与 server browser-session.ts 同 idiom (@alicloud 同坑见 MEMORY)
const puppeteerExtra: any = (puppeteerExtraImport as any)?.default ?? puppeteerExtraImport;
const StealthPlugin: () => any = (StealthPluginImport as any)?.default ?? StealthPluginImport;
puppeteerExtra.use(StealthPlugin());

// launch args 参考 server browser-session.ts LAUNCH_ARGS (窗口尺寸改 1366x900 与推送视口一致)
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--window-size=1366,900",
];

/** 平台主页 (登录入口 = 创作后台首页, 未登录会出登录页/弹窗) */
export const PLATFORM_HOME: Record<string, string> = {
  douyin: "https://creator.douyin.com",
  wechat_video: "https://channels.weixin.qq.com",
};

/** 打开账号专属有头浏览器 (持久 profile)。用完调用方负责 browser.close()。 */
export async function launchAccountBrowser(accountId: string): Promise<Browser> {
  const dir = profileDir(accountId);
  await mkdir(dir, { recursive: true });
  const browser = (await puppeteerExtra.launch({
    headless: false,
    userDataDir: dir,
    args: LAUNCH_ARGS,
    defaultViewport: { width: 1366, height: 900 },
  })) as unknown as Browser;
  logger.info({ accountId: accountId.slice(0, 8), profile: dir }, "账号浏览器已启动 (有头/持久profile)");
  return browser;
}

/** 复用浏览器自带首个标签页打开平台主页, 留 3s 渲染 */
export async function openPlatformHome(browser: Browser, platform: string): Promise<Page> {
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  const home = PLATFORM_HOME[platform];
  if (!home) throw new Error(`平台 ${platform} 不支持本地浏览器登录`);
  await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3_000));
  return page;
}

/** 抖音: 登录弹窗不改 URL — 有登录弹窗文案=未登录; 进 creator-micro 或出现创作者中心文案=已登录
 *  (移植自 server browser-session.ts douyinPageLoggedIn, 判定逻辑一字不改) */
async function douyinPageLoggedIn(page: Page): Promise<boolean> {
  try {
    const txt: string = await page.evaluate(() => (globalThis as any).document?.body?.innerText ?? "");
    if (/扫码登录|验证码登录|手机号登录|登录后即可|登录抖音/.test(txt)) return false;
    if (/creator-micro/.test(page.url())) return true;
    return /发布作品|内容管理|数据概览|创作者服务/.test(txt);
  } catch { return false; }
}

/** 登录态判定: 抖音=页面内容判定; 视频号=URL 判定 (channels platform/micro 且非 login) */
export async function isLoggedIn(page: Page, platform: string): Promise<boolean> {
  if (platform === "douyin") return douyinPageLoggedIn(page);
  if (platform === "wechat_video") {
    const url = page.url();
    return /channels\.weixin\.qq\.com\/(platform|micro)/.test(url) && !url.includes("login");
  }
  return false;
}
