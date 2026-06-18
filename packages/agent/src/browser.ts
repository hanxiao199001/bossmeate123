/**
 * 本地有头浏览器管理 — 每账号持久 profile (userDataDir 落盘):
 * 扫码与推送同一浏览器环境, 登录态原生在磁盘上, 不做 cookie 移植
 * (抖音 cookie 移植必被风控踢 — server browser-session.ts 实测结论)。
 */
import addExtraImport from "puppeteer-extra";
import rebrowserImport from "rebrowser-puppeteer";
import StealthPluginImport from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "rebrowser-puppeteer";
import { mkdir, readlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { profileDir } from "./config.js";
import { logger } from "./log.js";

// 显式锁定 rebrowser 的 CDP Runtime.enable 修复模式(默认即 addBinding, 显式写防上游改默认)
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ??= "addBinding";

// CJS interop unwrap — 与 server browser-session.ts 同 idiom (@alicloud 同坑见 MEMORY)
const rebrowser: any = (rebrowserImport as any)?.default ?? rebrowserImport;
const StealthPlugin: () => any = (StealthPluginImport as any)?.default ?? StealthPluginImport;
// addExtra 把 stealth 挂到 rebrowser 内核上(rebrowser 补 CDP 层,stealth 补 JS 层,互补)
// puppeteer-extra 的 addExtra 是具名函数, 挂在 default.addExtra(CJS interop); 默认导出本身是单例对象不是函数。
// (CC 当初为过 tsc 改成默认导入取 .default → 取到单例 → "addExtra is not a function" 运行时崩)
const aeNS: any = addExtraImport;
const addExtra: any = aeNS?.addExtra ?? aeNS?.default?.addExtra ?? aeNS;
const puppeteerExtra: any = addExtra(rebrowser);
puppeteerExtra.use(StealthPlugin());

// launch args 参考 server browser-session.ts LAUNCH_ARGS (窗口尺寸改 1366x900 与推送视口一致)
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--window-size=1366,900",
  // 6-16 抖音反滑块: 去掉 navigator.webdriver / 自动化特征, 减少风控弹滑块
  "--disable-blink-features=AutomationControlled",
  // 6-18 防 Edge 首启体验/默认浏览器询问页占住标签(卡 about:blank 不跳转)
  "--no-first-run",
  "--no-default-browser-check",
];

// 用系统自带浏览器(免装 Node 便携版需要): Windows→Edge, Mac→Edge/Chrome。
// 找不到则返回 undefined → puppeteer 回退自带 Chromium(开发机/装了 puppeteer 的情况)。
// 可用环境变量 BOSSMATE_BROWSER_PATH 强制指定。
function findSystemBrowser(): string | undefined {
  if (process.env.BOSSMATE_BROWSER_PATH && existsSync(process.env.BOSSMATE_BROWSER_PATH)) {
    return process.env.BOSSMATE_BROWSER_PATH;
  }
  const cands = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : process.platform === "darwin"
    ? [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ]
    : [];
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* noop */ }
  }
  return undefined;
}
const SYSTEM_BROWSER = findSystemBrowser();
if (SYSTEM_BROWSER) logger.info({ browser: SYSTEM_BROWSER }, "使用系统浏览器(免下 Chromium)");

/** 平台主页 (登录入口 = 创作后台首页, 未登录会出登录页/弹窗) */
export const PLATFORM_HOME: Record<string, string> = {
  douyin: "https://creator.douyin.com",
  wechat_video: "https://channels.weixin.qq.com",
};

/** SingletonLock 处理: Chrome 持久 profile 同时只能被一个实例用。
 *  锁是个 symlink 指向 "hostname-pid": pid 还活着=真有实例在跑(如上一条半自动窗口);
 *  pid 死了=上次崩溃/被 kill 留下的残锁, 清掉即可。 */
async function inspectSingletonLock(dir: string): Promise<"live" | "cleaned" | "none"> {
  let target: string;
  try { target = await readlink(join(dir, "SingletonLock")); } catch { return "none"; }
  const pid = Number(target.split("-").pop());
  if (Number.isFinite(pid) && pid > 0) {
    try { process.kill(pid, 0); return "live"; } catch { /* 进程已死 → 残锁 */ }
  }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { await rm(join(dir, f), { force: true }); } catch { /* noop */ }
  }
  logger.warn({ profile: dir }, "清理了残留的浏览器 profile 锁 (上次未正常退出)");
  return "cleaned";
}

function isSingletonError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Singleton|ProcessSingleton|Failed to launch the browser process/.test(msg);
}

/** 打开账号专属有头浏览器 (持久 profile)。用完调用方负责 browser.close()。 */
export async function launchAccountBrowser(accountId: string): Promise<Browser> {
  const dir = profileDir(accountId);
  await mkdir(dir, { recursive: true });
  const doLaunch = async (): Promise<Browser> =>
    (await puppeteerExtra.launch({
      headless: false,
      userDataDir: dir,
      args: LAUNCH_ARGS,
      // 去掉 "正由自动测试软件控制" 横幅 + --enable-automation 标记(抖音据此弹滑块)
      ignoreDefaultArgs: ["--enable-automation"],
      defaultViewport: { width: 1366, height: 900 },
      // 便携版: 用系统 Edge/Chrome; 未找到则 undefined → 回退自带 Chromium
      ...(SYSTEM_BROWSER ? { executablePath: SYSTEM_BROWSER } : {}),
    })) as unknown as Browser;

  let browser: Browser;
  try {
    browser = await doLaunch();
  } catch (err) {
    if (!isSingletonError(err)) throw err;
    const lock = await inspectSingletonLock(dir);
    if (lock === "live") {
      throw new Error(
        "该账号的浏览器窗口已在运行 (大概率是上一条半自动任务停在发布页等人工点发布) — 请先到那个窗口点【发布】并关闭窗口, 再重派本任务"
      );
    }
    browser = await doLaunch(); // 残锁已清, 重试一次
  }
  logger.info({ accountId: accountId.slice(0, 8), profile: dir }, "账号浏览器已启动 (有头/持久profile)");
  return browser;
}

/** 登录成功后抓取平台真实账号信息(昵称 + 平台账号ID), 用于回填账号管理防张冠李戴。
 *  抓不到不报错(返回空), 纯文本正则提取, 抗 DOM 改版。 */
export async function scrapeAccountProfile(page: Page, platform: string): Promise<{ nickname?: string; uid?: string }> {
  try {
    const txt = (await page
      .evaluate(() => {
        const doc = (globalThis as any).document;
        return doc?.body?.innerText || "";
      })
      .catch(() => "")) as string;
    if (!txt) return {};
    if (platform === "douyin") {
      const uid = txt.match(/抖音号[:：]\s*([0-9A-Za-z_.\-]{4,32})/)?.[1];
      let nickname: string | undefined;
      const m = txt.match(/([^\n\r|｜]{2,24})\s*[|｜]\s*抖音号[:：]/);
      if (m) nickname = m[1].trim();
      return { nickname, uid };
    }
    if (platform === "wechat_video") {
      const uid = txt.match(/视频号(?:ID|账号|号)?[:：]?\s*([A-Za-z0-9_\-]{4,})/)?.[1];
      return { uid };
    }
  } catch { /* noop */ }
  return {};
}

/** 打开平台主页, 留 3s 渲染。默认复用首个标签页; newTab=true 时新开标签页
 *  (复用半自动任务留下的浏览器时必须新开, 不能动用户待点发布的那个标签)。 */
export async function openPlatformHome(browser: Browser, platform: string, newTab = false): Promise<Page> {
  const home = PLATFORM_HOME[platform];
  if (!home) throw new Error(`平台 ${platform} 不支持本地浏览器登录`);
  // 6-18: 始终新开一页导航 — Edge 启动占住的初始 about:blank 可能不是 puppeteer 实际控制的可见页,
  // 复用它会"卡 about:blank 不跳转"(已确诊为浏览器控制问题)。新开的页一定是受控页。
  const page = await browser.newPage();
  await page.bringToFront().catch(() => {});
  // 6-18: 跳转加固 — 重试一次; 即使超时也不硬失败(登录二维码可能已渲染); 记录最终地址便于排查"卡 about:blank"。
  let navOk = false;
  for (let attempt = 1; attempt <= 2 && !navOk; attempt++) {
    try {
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 45_000 });
      navOk = true;
    } catch (e) {
      logger.warn(`打开 ${home} 第 ${attempt} 次未在 45s 内完成: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  await page.bringToFront().catch(() => {});
  if (!newTab) {
    // 关掉 Edge 启动残留的空白标签, 只留导航好的这页
    for (const p of await browser.pages()) {
      if (p !== page) {
        const u = p.url();
        if (u === "about:blank" || u === "") await p.close().catch(() => {});
      }
    }
  }
  await new Promise((r) => setTimeout(r, 3_000));
  logger.info(`已打开 ${platform} 登录页, 当前地址: ${page.url()}`);
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
