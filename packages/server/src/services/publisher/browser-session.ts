/**
 * PR-S1: 浏览器登录会话管理 — 半自动平台(抖音/视频号)扫码登录拿登录态
 *
 * 流程: startQrLogin → puppeteer(stealth) 打开平台登录页 → 截取二维码 →
 *       前端轮询 getQrLoginStatus 展示二维码 → 用户手机扫码 →
 *       检测登录成功 → 抓 cookies+localStorage 加密存 platform_accounts.login_state
 *
 * 设计:
 * - 复用 stealth-fetcher 的 puppeteer-extra + StealthPlugin idiom (CJS interop unwrap)
 * - 独立 browser 单例 (不与 crawler/video 共享, 避免互相干扰)
 * - 会话内存表, 同账号新会话顶掉旧会话, 全局并发上限 2, 180s 超时
 * - 二维码截取: 启发式找页面上最大的"接近正方形"img/canvas (选择器易变, 不写死)
 */

import puppeteerExtraImport from "puppeteer-extra";
import StealthPluginImport from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { platformAccounts } from "../../models/schema.js";
import { encryptCredentials, decryptCredentials } from "../../utils/crypto.js";
import { logger } from "../../config/logger.js";

const puppeteerExtra: any = (puppeteerExtraImport as any)?.default ?? puppeteerExtraImport;
const StealthPlugin: () => any = (StealthPluginImport as any)?.default ?? StealthPluginImport;
puppeteerExtra.use(StealthPlugin());

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--window-size=1280,900",
];

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  if (launching) return launching;
  launching = (async () => {
    const b = (await puppeteerExtra.launch({ headless: true, args: LAUNCH_ARGS })) as unknown as Browser;
    logger.info("browser-session puppeteer 启动完成");
    b.on("disconnected", () => {
      logger.warn("browser-session puppeteer disconnected");
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

// ===== 平台配置 =====
interface PlatformLoginConfig {
  loginUrl: string;
  /** url 判定: 登录成功后会离开登录页 */
  isLoggedInUrl: (url: string) => boolean;
  /** 关键 cookie 名 (任一存在即认为有登录态) */
  sessionCookies: string[];
}

export const BROWSER_LOGIN_PLATFORMS: Record<string, PlatformLoginConfig> = {
  douyin: {
    loginUrl: "https://creator.douyin.com",
    isLoggedInUrl: (url) => url.includes("creator-micro") && !url.includes("login"),
    sessionCookies: ["sessionid", "sessionid_ss"],
  },
  wechat_video: {
    loginUrl: "https://channels.weixin.qq.com",
    isLoggedInUrl: (url) =>
      /channels\.weixin\.qq\.com\/(platform|micro)/.test(url) && !url.includes("login"),
    sessionCookies: ["sessionid", "wxuin"],
  },
};

// ===== 会话表 =====
export type QrLoginStatus = "starting" | "waiting" | "success" | "expired" | "failed";

interface QrSession {
  sessionId: string;
  accountId: string;
  tenantId: string;
  platform: string;
  status: QrLoginStatus;
  qrPng?: string; // base64
  error?: string;
  page?: Page;
  timer?: ReturnType<typeof setInterval>;
  createdAt: number;
}

const sessions = new Map<string, QrSession>();
const SESSION_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT = 2;

function activeCount(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.status === "starting" || s.status === "waiting") n++;
  return n;
}

async function closeSession(s: QrSession, status: QrLoginStatus, error?: string) {
  s.status = status;
  if (error) s.error = error;
  if (s.timer) { clearInterval(s.timer); s.timer = undefined; }
  if (s.page) {
    try { await s.page.close(); } catch { /* noop */ }
    s.page = undefined;
  }
  // 终态会话 10 分钟后清理 (留给前端轮询读结果)
  setTimeout(() => sessions.delete(s.sessionId), 600_000).unref?.();
}

/** 启发式截取页面上的二维码: 选最大的接近正方形且 ≥100px 的 img/canvas */
async function captureQr(page: Page): Promise<string | null> {
  try {
    const handle = await page.evaluateHandle(() => {
      // 浏览器上下文执行 — server tsconfig 无 DOM lib, 经 globalThis 取 document
      const doc = (globalThis as any).document;
      const cands = Array.from(doc.querySelectorAll("img, canvas")) as any[];
      let best: any = null;
      let bestArea = 0;
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        const ratio = r.width / r.height;
        if (ratio < 0.8 || ratio > 1.25) continue; // 接近正方形
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
      return best;
    });
    const el = handle.asElement();
    if (el) {
      const buf = await (el as any).screenshot({ encoding: "base64" });
      await handle.dispose();
      return typeof buf === "string" ? buf : Buffer.from(buf).toString("base64");
    }
    await handle.dispose();
    // 兜底: 整页截图 (用户也能从中扫码)
    const full = await page.screenshot({ encoding: "base64" });
    return typeof full === "string" ? full : Buffer.from(full).toString("base64");
  } catch {
    return null;
  }
}

/** 登录成功 → 抓全量 cookies(CDP) + localStorage, 加密落库 */
async function persistLoginState(s: QrSession) {
  const page = s.page!;
  const cdp = await page.target().createCDPSession();
  const { cookies } = (await cdp.send("Network.getAllCookies")) as { cookies: any[] };
  let localStorageJson = "{}";
  try {
    localStorageJson = await page.evaluate(() => JSON.stringify({ ...(globalThis as any).localStorage }));
  } catch { /* 跨域等忽略 */ }
  const state = { cookies, localStorage: localStorageJson, origin: page.url(), savedAt: new Date().toISOString() };
  await db
    .update(platformAccounts)
    .set({
      loginState: encryptCredentials(JSON.stringify(state)),
      loginStatus: "logged_in",
      loginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(platformAccounts.id, s.accountId), eq(platformAccounts.tenantId, s.tenantId)));
  logger.info({ accountId: s.accountId, platform: s.platform, cookieCount: cookies.length }, "扫码登录成功, 登录态已落库");
}

/** 发起扫码登录会话 */
export async function startQrLogin(params: { accountId: string; tenantId: string; platform: string }): Promise<{ sessionId: string }> {
  const cfg = BROWSER_LOGIN_PLATFORMS[params.platform];
  if (!cfg) throw new Error(`平台 ${params.platform} 不支持浏览器登录`);
  if (activeCount() >= MAX_CONCURRENT) throw new Error("当前登录会话已满, 请稍后再试");

  // 同账号旧会话顶掉
  for (const s of sessions.values()) {
    if (s.accountId === params.accountId && (s.status === "starting" || s.status === "waiting")) {
      await closeSession(s, "expired", "被新会话替代");
    }
  }

  const session: QrSession = {
    sessionId: randomUUID(),
    accountId: params.accountId,
    tenantId: params.tenantId,
    platform: params.platform,
    status: "starting",
    createdAt: Date.now(),
  };
  sessions.set(session.sessionId, session);

  // 异步启动, 不阻塞接口返回
  (async () => {
    try {
      const b = await getBrowser();
      const page = await b.newPage();
      session.page = page;
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(cfg.loginUrl, { waitUntil: "networkidle2", timeout: 45_000 });
      // 给登录页二维码渲染留时间
      await new Promise((r) => setTimeout(r, 3_000));
      session.qrPng = (await captureQr(page)) ?? undefined;
      session.status = "waiting";

      session.timer = setInterval(async () => {
        try {
          if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
            await closeSession(session, "expired", "二维码超时, 请重新发起");
            return;
          }
          const url = page.url();
          let loggedIn = cfg.isLoggedInUrl(url);
          if (!loggedIn) {
            const cookies = await page.cookies();
            loggedIn = cookies.some((c) => cfg.sessionCookies.includes(c.name) && c.value);
          }
          if (loggedIn) {
            if (session.timer) { clearInterval(session.timer); session.timer = undefined; }
            // 等页面稳定再抓 state
            await new Promise((r) => setTimeout(r, 2_000));
            await persistLoginState(session);
            await closeSession(session, "success");
            return;
          }
          // 未登录: 刷新二维码截图 (平台二维码会轮换)
          const qr = await captureQr(page);
          if (qr) session.qrPng = qr;
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err, sessionId: session.sessionId }, "qr-login 轮询异常");
        }
      }, 2_500);
    } catch (err) {
      logger.error({ err, accountId: params.accountId }, "qr-login 启动失败");
      await closeSession(session, "failed", err instanceof Error ? err.message : "启动失败");
    }
  })();

  return { sessionId: session.sessionId };
}

/** 查询会话状态 (带租户校验) */
export function getQrLoginStatus(sessionId: string, tenantId: string): { status: QrLoginStatus; qrPng?: string; error?: string } | null {
  const s = sessions.get(sessionId);
  if (!s || s.tenantId !== tenantId) return null;
  return {
    status: s.status,
    qrPng: s.status === "waiting" ? s.qrPng : undefined,
    error: s.error,
  };
}

/** 读取并解密某账号登录态 (推草稿用) */
export async function loadLoginState(accountId: string, tenantId: string): Promise<{ cookies: any[]; localStorage: string } | null> {
  const [acct] = await db
    .select()
    .from(platformAccounts)
    .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.tenantId, tenantId)))
    .limit(1);
  if (!acct?.loginState || acct.loginStatus !== "logged_in") return null;
  try {
    const json = decryptCredentials(acct.loginState as unknown as string);
    const state = JSON.parse(json);
    return { cookies: state.cookies ?? [], localStorage: state.localStorage ?? "{}" };
  } catch (err) {
    logger.error({ err, accountId }, "登录态解密失败");
    return null;
  }
}

/** 登录态失效时标记 (推草稿检测到被踢出时调用) */
export async function markLoginExpired(accountId: string, tenantId: string) {
  await db
    .update(platformAccounts)
    .set({ loginStatus: "expired", updatedAt: new Date() })
    .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.tenantId, tenantId)));
}

export { getBrowser as getSessionBrowser };
