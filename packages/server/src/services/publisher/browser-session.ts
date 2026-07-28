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
import type { Browser, BrowserContext, Page } from "puppeteer";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { platformAccounts } from "../../models/schema.js";
import { encryptCredentials, decryptCredentials } from "../../utils/crypto.js";
import { logger } from "../../config/logger.js";
import { definePlatformMap } from "../platforms/capabilities.js";

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

// ===== 按账号持久化 profile (抖音风控: cookie 移植必被踢, 扫码与推送必须同一浏览器环境) =====
const PROFILE_DIR = resolve(process.cwd(), "data/profiles");
const profileEntries = new Map<string, { p: Promise<Browser>; refs: number }>();

/** 打开(或复用)账号专属浏览器, userDataDir 落盘持久化。用完必须 releaseProfileBrowser。 */
export async function acquireProfileBrowser(accountId: string): Promise<Browser> {
  const existing = profileEntries.get(accountId);
  if (existing) {
    const b = await existing.p.catch(() => null);
    if (b && b.connected) { existing.refs++; return b; }
    profileEntries.delete(accountId);
  }
  const entry = {
    refs: 1,
    p: (async () => {
      const dir = resolve(PROFILE_DIR, accountId);
      await mkdir(dir, { recursive: true });
      const b = (await puppeteerExtra.launch({ headless: true, args: LAUNCH_ARGS, userDataDir: dir })) as unknown as Browser;
      logger.info({ accountId }, "profile 浏览器已启动");
      return b;
    })(),
  };
  profileEntries.set(accountId, entry);
  try {
    return await entry.p;
  } catch (err) {
    profileEntries.delete(accountId);
    throw err;
  }
}

/** 引用计数减一, 归零关浏览器 (profile 目录保留, 登录态在磁盘上) */
export async function releaseProfileBrowser(accountId: string) {
  const entry = profileEntries.get(accountId);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  profileEntries.delete(accountId);
  try { (await entry.p).close(); } catch { /* noop */ }
}

// ===== 平台配置 =====
interface PlatformLoginConfig {
  loginUrl: string;
  /** url 判定: 登录成功后会离开登录页 */
  isLoggedInUrl: (url: string) => boolean;
  /** 关键 cookie 名 (任一存在即认为有登录态) */
  sessionCookies: string[];
  /** session cookie 必须挂在这些域后缀上 (防跨平台同名 cookie 串台) */
  cookieDomains: string[];
  /** 扫码/推送共用按账号持久 profile (抖音: cookie 移植被风控踢, 必须同环境) */
  persistentProfile?: boolean;
  /** 自定义登录判定 (抖音登录框是同 URL 弹窗, URL/cookie 判定都会误报) */
  checkLoggedIn?: (page: Page) => Promise<boolean>;
}

/** 抖音: 登录弹窗不改 URL — 有登录弹窗文案=未登录; 进 creator-micro 或出现创作者中心文案=已登录 */
async function douyinPageLoggedIn(page: Page): Promise<boolean> {
  try {
    const txt: string = await page.evaluate(() => (globalThis as any).document?.body?.innerText ?? "");
    if (/扫码登录|验证码登录|手机号登录|登录后即可|登录抖音/.test(txt)) return false;
    if (/creator-micro/.test(page.url())) return true;
    return /发布作品|内容管理|数据概览|创作者服务/.test(txt);
  } catch { return false; }
}

/**
 * 扫码登录的**行为配置**(含 puppeteer 判定函数, 所以不能进纯数据的 capabilities 表)。
 * key 集合由 PLATFORM_CAPABILITIES.browserLogin 校验 —— 表里标了 browserLogin 却没配置,
 * 或配置了表里没标, 都在模块加载时直接抛错(而不是线上"该平台扫码入口神秘消失")。
 */
export const BROWSER_LOGIN_PLATFORMS: Record<string, PlatformLoginConfig> = definePlatformMap<PlatformLoginConfig>("browserLogin", {
  douyin: {
    loginUrl: "https://creator.douyin.com",
    // 登录后跳 creator-micro/home; 放宽为"在 creator.douyin.com 且不在 login 页"
    isLoggedInUrl: (url) =>
      /creator\.douyin\.com\/creator-micro/.test(url) ||
      (/creator\.douyin\.com/.test(url) && !/login|passport/.test(url)),
    sessionCookies: ["sessionid", "sessionid_ss", "sid_tt", "uid_tt"],
    cookieDomains: ["douyin.com"],
    persistentProfile: true,
    checkLoggedIn: douyinPageLoggedIn,
  },
  wechat_video: {
    loginUrl: "https://channels.weixin.qq.com",
    isLoggedInUrl: (url) =>
      /channels\.weixin\.qq\.com\/(platform|micro)/.test(url) && !url.includes("login"),
    sessionCookies: ["sessionid", "wxuin"],
    cookieDomains: ["weixin.qq.com", "qq.com"],
  },
});

// ===== 会话表 =====
export type QrLoginStatus = "starting" | "waiting" | "waiting_sms" | "success" | "expired" | "failed";

interface QrSession {
  sessionId: string;
  accountId: string;
  tenantId: string;
  platform: string;
  status: QrLoginStatus;
  qrPng?: string; // base64
  error?: string;
  page?: Page;
  context?: BrowserContext;
  profileAccountId?: string;
  /** cookie 已现但页面未跳转时的主动刷新次数 (上限3) */
  reloads?: number;
  /** 抖音身份验证: 是否已点"接收短信验证码" */
  smsRequested?: boolean;
  /** 自动推进尝试次数 (上限后让位给用户远程点击) */
  autoTries?: number;
  /** 用户已开始远程点击接管, 自动点击停手 */
  userDriving?: boolean;
  /** 鼠标互斥锁: page.mouse 不允许并发按下 ('left is already pressed'), 所有点击串行 */
  mouseLock?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  createdAt: number;
}

const sessions = new Map<string, QrSession>();
const SESSION_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT = 2;

function activeCount(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.status === "starting" || s.status === "waiting" || s.status === "waiting_sms") n++;
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
  if (s.context) {
    try { await s.context.close(); } catch { /* noop */ }
    s.context = undefined;
  }
  if (s.profileAccountId) {
    await releaseProfileBrowser(s.profileAccountId);
    s.profileAccountId = undefined;
  }
  // 终态会话 10 分钟后清理 (留给前端轮询读结果)
  setTimeout(() => sessions.delete(s.sessionId), 600_000).unref?.();
}

/**
 * 启发式截取二维码: 在每个 frame 内找"接近正方形、边长 100-340px"的 img/canvas。
 * - iframe 优先(抖音登录二维码在独立 passport iframe; 主文档常有大宣传卡误判)
 * - 边长上限 340 过滤掉宣传卡/大图, 二维码一般 ~200px
 * - 都没有 → 整页截图兜底
 */
async function findQrInFrame(frame: any): Promise<string | null> {
  try {
    const handle = await frame.evaluateHandle(() => {
      const doc = (globalThis as any).document;
      const cands = Array.from(doc.querySelectorAll("img, canvas")) as any[];
      let best: any = null;
      let bestArea = 0;
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        const w = r.width, h = r.height;
        if (w < 100 || h < 100 || w > 340 || h > 340) continue; // 二维码尺寸带
        const ratio = w / h;
        if (ratio < 0.8 || ratio > 1.25) continue; // 接近正方形
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = el; }
      }
      return best;
    });
    const el = handle.asElement();
    if (el) {
      const buf = await el.screenshot({ encoding: "base64" });
      await handle.dispose();
      return typeof buf === "string" ? buf : Buffer.from(buf).toString("base64");
    }
    await handle.dispose();
    return null;
  } catch {
    return null; // frame 跨域/已 detach
  }
}

/**
 * 主文档二维码提取 — 不依赖截屏。
 * 坐标截图在动态布局/轮播 banner 下会截错位(实测两轮踩坑: 半个码 / 截成宣传图)。
 * 直接从 DOM 抠像素: canvas.toDataURL 拿二维码原始像素(抖音是 canvas);
 * img 画到离屏 canvas 再 toDataURL (cross-origin taint 抛错则退回矩形坐标给 clip 兜底)。
 * 选择: 祖先 6 层内含"扫码/扫一扫/二维码/登录"文案强加权, canvas 加权, 正方形 80-400px。
 */
async function extractQrFromMain(page: Page): Promise<{ dataUrl?: string; rect?: { x: number; y: number; width: number; height: number } } | null> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const cands = Array.from(doc.querySelectorAll("img, canvas")) as any[];
      let best: any = null;
      let bestScore = 0;
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        const w = r.width, h = r.height;
        if (w < 80 || h < 80 || w > 400 || h > 400) continue;
        const ratio = w / h;
        if (ratio < 0.85 || ratio > 1.18) continue;
        let score = 10_000 + w * h * 0.01;
        if (el.tagName === "CANVAS") score += 5_000;
        let anc = el.parentElement;
        for (let i = 0; i < 6 && anc; i++, anc = anc.parentElement) {
          const t = (anc.textContent || "");
          if (t.length < 500 && /扫码|扫一扫|二维码|登录/.test(t)) { score += 20_000; break; }
        }
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (!best) return null;
      const r = best.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      try {
        if (best.tagName === "CANVAS") return { dataUrl: best.toDataURL("image/png"), rect };
        const c = doc.createElement("canvas");
        c.width = best.naturalWidth || Math.round(r.width);
        c.height = best.naturalHeight || Math.round(r.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(best, 0, 0, c.width, c.height);
        return { dataUrl: c.toDataURL("image/png"), rect };
      } catch {
        return { rect }; // cross-origin taint → 退回坐标
      }
    });
  } catch {
    return null;
  }
}

async function captureQr(page: Page): Promise<string | null> {
  try {
    // 1. 主文档 DOM 直抠像素 (canvas.toDataURL, 与布局/遮挡/动画无关)
    const found = await extractQrFromMain(page);
    if (found?.dataUrl) {
      const b64 = found.dataUrl.replace(/^data:image\/\w+;base64,/, "");
      if (b64.length > 1_000) return b64; // 过小=空白canvas, 走兜底
    }
    // 1b. 退化: 坐标 clip 截取 (带 12px 边距, 钳制在视口内)
    const rect = found?.rect ?? null;
    if (rect) {
      const vp = page.viewport() ?? { width: 1280, height: 900 };
      const pad = 12;
      const x = Math.max(0, rect.x - pad);
      const y = Math.max(0, rect.y - pad);
      const clip = {
        x, y,
        width: Math.min(vp.width - x, rect.width + pad * 2),
        height: Math.min(vp.height - y, rect.height + pad * 2),
      };
      if (clip.width > 50 && clip.height > 50) {
        const buf = await page.screenshot({ encoding: "base64", clip });
        return typeof buf === "string" ? buf : Buffer.from(buf).toString("base64");
      }
    }
    // 2. iframe 内二维码 (独立 passport 登录页形态)
    const frames = page.frames();
    for (const frame of frames.filter((f) => f !== page.mainFrame())) {
      const qr = await findQrInFrame(frame);
      if (qr) return qr;
    }
    // 3. 兜底: 整页截图 (二维码在页面上就能扫)
    const full = await page.screenshot({ encoding: "base64" });
    return typeof full === "string" ? full : Buffer.from(full).toString("base64");
  } catch {
    return null;
  }
}

/** 深度找文本命中元素并用真实鼠标点击 (trusted event, 抖音验证按钮 el.click 不响应) */
async function deepClickByText(page: Page, pattern: RegExp): Promise<boolean> {
  try {
    const hit = await page.evaluate((src: string) => {
      const re = new RegExp(src);
      const doc = (globalThis as any).document;
      function* deep(root: any): any {
        const els = root.querySelectorAll("*");
        for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
      }
      let target: any = null;
      for (const el of deep(doc)) {
        const t = (el.textContent || "").trim();
        if (t.length === 0 || t.length > 30 || !re.test(t)) continue;
        target = el; // 越深越内层, 后命中覆盖
      }
      if (!target) return null;
      // 命中的常是内层文字 → 向上找真正可点击的"行/按钮"(role/button/a/li/cursor:pointer/可点 class)
      let clickable = target;
      let node = target;
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        const tag = node.tagName;
        const role = node.getAttribute?.("role");
        const cls = (node.className || "").toString();
        const cursor = (() => { try { return (globalThis as any).getComputedStyle(node).cursor; } catch { return ""; } })();
        if (tag === "BUTTON" || tag === "A" || tag === "LI" || role === "button" ||
            cursor === "pointer" || /item|cell|btn|option|row|list/i.test(cls)) { clickable = node; break; }
      }
      clickable.scrollIntoView({ block: "center", inline: "center" });
      const r = clickable.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, pattern.source);
    if (!hit) return false;
    await page.mouse.click(hit.x, hit.y, { delay: 50 });
    return true;
  } catch { return false; }
}

/** 抖音身份验证: 用户在前端输入短信验证码 → 填入页面并提交 */
export async function submitSmsCode(sessionId: string, tenantId: string, code: string): Promise<{ ok: boolean; message?: string }> {
  const s = sessions.get(sessionId);
  if (!s || s.tenantId !== tenantId) return { ok: false, message: "会话不存在或已过期" };
  if (!s.page || s.status !== "waiting_sms") return { ok: false, message: "当前不在短信验证步骤" };
  const page = s.page;
  try {
    const typed = await page.evaluate((val: string) => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;
      function* deep(root: any): any {
        const els = root.querySelectorAll("*");
        for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
      }
      for (const el of deep(doc)) {
        if (el.tagName !== "INPUT") continue;
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (!["text", "tel", "number"].includes(type)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 10) continue;
        const ph = el.getAttribute("placeholder") || "";
        const ml = el.getAttribute("maxlength") || "";
        if (!/验证码/.test(ph) && ml !== "6" && ml !== "4") continue;
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(el, val); else el.value = val;
        el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
        return true;
      }
      return false;
    }, code.trim());
    if (!typed) return { ok: false, message: "页面上找不到验证码输入框, 请重新发起扫码" };
    await new Promise((r) => setTimeout(r, 800));
    await withMouseLock(s, () => deepClickByText(page, /^(验证|确定|提交|确认)$/));
    s.status = "waiting"; // 交回轮询判定; 若验证失败弹窗仍在, 下一拍会切回 waiting_sms
    logger.info({ sessionId }, "qr-login: 短信验证码已提交");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "提交失败" };
  }
}

/** 抖音身份验证: 重新发送短信验证码 (机房 IP 发送失败时用户手动重发) */
export async function resendSmsCode(sessionId: string, tenantId: string): Promise<{ ok: boolean; message?: string }> {
  const s = sessions.get(sessionId);
  if (!s || s.tenantId !== tenantId) return { ok: false, message: "会话不存在或已过期" };
  if (!s.page) return { ok: false, message: "会话页面已关闭" };
  const sent = await withMouseLock(s, () => deepClickByText(s.page!, /获取验证码|发送验证码|重新发送|重新获取|发送短信/));
  if (!sent) return { ok: false, message: "页面上找不到发送按钮(可能在倒计时中, 请等几秒)" };
  s.createdAt = Date.now();
  logger.info({ sessionId }, "qr-login: 用户手动重发短信验证码");
  return { ok: true };
}

/** 串行化同一会话上的鼠标操作 (并发 mouse.down 会炸 'left is already pressed') */
function withMouseLock<T>(s: QrSession, fn: () => Promise<T>): Promise<T> {
  const run = (s.mouseLock ?? Promise.resolve()).catch(() => undefined).then(fn);
  s.mouseLock = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 远程点击: 前端在实时截图上点, 坐标按比例转发到真实页面 (page.mouse 真实输入,
 * 不分 iframe/shadow DOM, 任何验证弹窗都能操作 — 元素查找式自动点击的最终兜底)。
 */
export async function remoteClick(sessionId: string, tenantId: string, xRatio: number, yRatio: number): Promise<{ ok: boolean; message?: string }> {
  const s = sessions.get(sessionId);
  if (!s || s.tenantId !== tenantId) return { ok: false, message: "会话不存在或已过期" };
  if (!s.page) return { ok: false, message: "会话页面已关闭" };
  if (!(xRatio >= 0 && xRatio <= 1 && yRatio >= 0 && yRatio <= 1)) return { ok: false, message: "坐标越界" };
  const page = s.page;
  s.userDriving = true; // 先置位: 后台自动点击立刻让位
  try {
    return await withMouseLock(s, async () => {
      const vp = page.viewport() ?? { width: 1280, height: 900 };
      await page.mouse.click(Math.round(xRatio * vp.width), Math.round(yRatio * vp.height), { delay: 50 });
      await new Promise((r) => setTimeout(r, 1_200));
      const shot = await page.screenshot({ encoding: "base64" }).catch(() => null);
      if (shot) s.qrPng = typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
      logger.info({ sessionId, xRatio: xRatio.toFixed(3), yRatio: yRatio.toFixed(3) }, "qr-login: 远程点击");
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "点击失败" };
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
    if (s.accountId === params.accountId && (s.status === "starting" || s.status === "waiting" || s.status === "waiting_sms")) {
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
      let page: Page;
      if (cfg.persistentProfile) {
        // 抖音: 账号专属持久 profile — 扫码与推送同一浏览器环境, 登录态不靠移植
        const pb = await acquireProfileBrowser(params.accountId);
        session.profileAccountId = params.accountId;
        page = await pb.newPage();
      } else {
        const b = await getBrowser();
        // 每个扫码会话独立隐身 context: cookie 从零开始。
        // 否则共享浏览器里残留的旧 cookie(可能已被平台踢失效, 或同名 sessionid 串台)
        // 会让轮询第一拍就误判"已登录", 把失效旧 cookie 重新落库 → 前端秒显成功但推送照样失败。
        const ctx = await b.createBrowserContext();
        session.context = ctx;
        page = await ctx.newPage();
      }
      session.page = page;
      await page.setViewport({ width: 1280, height: 900 });
      // 抖音/视频号创作页有长连接+轮询, networkidle2 永不触发 → 用 domcontentloaded
      await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // 给登录页二维码渲染留时间
      await new Promise((r) => setTimeout(r, 3_000));
      session.qrPng = (await captureQr(page)) ?? undefined;
      session.status = "waiting";

      const pollCdp = await page.target().createCDPSession();
      let pollTick = 0;
      session.timer = setInterval(async () => {
        try {
          if (Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
            await closeSession(session, "expired", "二维码超时, 请重新发起");
            return;
          }
          const url = page.url();
          // 全域 cookie (抖音 session 挂 .douyin.com, page.cookies() 只看当前域会漏)
          let allCookies: any[] = [];
          try {
            const r = (await pollCdp.send("Network.getAllCookies")) as { cookies: any[] };
            allCookies = r.cookies ?? [];
          } catch { /* fallback 下面用 page.cookies */ }
          if (allCookies.length === 0) {
            try { allCookies = await page.cookies(); } catch { /* noop */ }
          }
          const onPlatformDomain = (c: any) => cfg.cookieDomains.some((d) => String(c.domain ?? "").endsWith(d));
          const hasSession = allCookies.some((c) => cfg.sessionCookies.includes(c.name) && c.value && onPlatformDomain(c));
          // 抖音补充交互: 扫码确认后网页侧可能弹"身份验证"(新设备风控) 或 "确定登录"按钮
          if (cfg.checkLoggedIn) {
            const pageTxt: string = await page
              .evaluate(() => (globalThis as any).document?.body?.innerText ?? "")
              .catch(() => "");
            if (/身份验证|安全验证|验证身份/.test(pageTxt)) {
              // 抖音身份验证是多步: ①方式选择列表(短信/密码/...) ②进入短信页点"获取验证码"真正发短信 ③输码
              // 每拍都尝试推进, 直到页面出现验证码输入框才算短信已发
              const hasCodeInput = await page.evaluate(() => {
                const doc = (globalThis as any).document;
                function* deep(root: any): any { const els = root.querySelectorAll("*"); for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); } }
                for (const el of deep(doc)) {
                  if (el.tagName !== "INPUT") continue;
                  const ph = el.getAttribute("placeholder") || ""; const ml = el.getAttribute("maxlength") || "";
                  const r = el.getBoundingClientRect();
                  if (r.width > 30 && r.height > 10 && (/验证码/.test(ph) || ml === "6" || ml === "4")) return true;
                }
                return false;
              }).catch(() => false);

              // 短信页特征收紧: 只认验证码输入框/倒计时 (手机号掩码在方式选择列表也有, 会误判)
              const onSmsPage = hasCodeInput || /秒后重(新|发)|\d+s\s*后/.test(pageTxt);
              session.autoTries = (session.autoTries ?? 0) + 1;
              const autoAllowed = !session.userDriving && session.autoTries <= 3;
              if (!onSmsPage && autoAllowed) {
                // 仍在"方式选择"列表 → 点"发送短信验证"那一行进入短信页 (不点获取验证码!)
                const picked = await withMouseLock(session, () => deepClickByText(page, /短信/));
                logger.info({ sessionId: session.sessionId, picked }, "qr-login: 方式选择页, 点'短信验证'进入短信页");
              } else if (onSmsPage && !session.smsRequested && !session.userDriving) {
                // 已在短信页 → 点"获取验证码"真正发短信 (只点一次; 排除方式列表项'发送短信验证')
                const sent = await withMouseLock(session, () => deepClickByText(page, /获取验证码|发送验证码/));
                if (sent) {
                  session.smsRequested = true;
                  session.createdAt = Date.now();
                  logger.info({ sessionId: session.sessionId }, "qr-login: 已进短信页并点'获取验证码', 短信应已发出");
                } else {
                  logger.info({ sessionId: session.sessionId }, "qr-login: 在短信页但未找到'获取验证码'(可能倒计时中)");
                }
              }
              if ((onSmsPage || session.autoTries > 3 || session.userDriving) && session.status !== "waiting_sms") session.status = "waiting_sms";
              // 验证弹窗现场整页截图给前端看
              const shot = await page.screenshot({ encoding: "base64" }).catch(() => null);
              if (shot) session.qrPng = typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
            } else if (!session.userDriving && /确定登录/.test(pageTxt)) {
              await withMouseLock(session, () => deepClickByText(page, /^确定登录$/));
            }
          }
          let loggedIn: boolean;
          if (cfg.checkLoggedIn) {
            loggedIn = await cfg.checkLoggedIn(page);
            // 抖音: 扫码后 cookie 先落, 但 headless 下登录 iframe 完成后主页面常不自动跳转,
            // 内容判定会永远停在"等待扫码" → 见到 session cookie 就主动刷新让登录态生效
            if (!loggedIn && hasSession) {
              session.reloads = (session.reloads ?? 0) + 1;
              if (session.reloads <= 3) {
                logger.info({ sessionId: session.sessionId, reloads: session.reloads }, "qr-login: 已见 session cookie 但页面未跳转, 主动刷新");
                try { await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { /* noop */ }
                await new Promise((r) => setTimeout(r, 2_500));
                loggedIn = await cfg.checkLoggedIn(page);
              }
            }
          } else {
            loggedIn = cfg.isLoggedInUrl(url) || hasSession;
          }
          // 诊断全页截图: 每 8 轮 (~20s) 覆盖写一张, 扫码失败时直接看页面(滑块验证/二维码失效/环境异常)
          if (pollTick % 8 === 0) {
            try {
              const dir = resolve(process.cwd(), "data/uploads");
              await mkdir(dir, { recursive: true });
              await page.screenshot({ path: resolve(dir, `qr-debug-${session.platform}.png`) as any, fullPage: true });
            } catch { /* noop */ }
          }
          // 诊断日志: 每 4 轮 (~10s) 打一次, 便于定位卡点
          if (pollTick++ % 4 === 0) {
            logger.info({
              sessionId: session.sessionId, platform: session.platform, url,
              hasSession, cookieCount: allCookies.length,
              sessionCookieNames: allCookies.filter((c) => cfg.sessionCookies.includes(c.name)).map((c) => c.name),
            }, "qr-login 轮询状态");
          }
          if (loggedIn) {
            if (session.timer) { clearInterval(session.timer); session.timer = undefined; }
            // 等页面稳定再抓 state
            await new Promise((r) => setTimeout(r, 2_000));
            await persistLoginState(session);
            await closeSession(session, "success");
            return;
          }
          // 未登录: 刷新二维码截图 (平台二维码会轮换); waiting_sms 态已放验证页截图, 不覆盖
          if (session.status === "waiting") {
            const qr = await captureQr(page);
            if (qr) session.qrPng = qr;
          }
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
    qrPng: s.status === "waiting" || s.status === "waiting_sms" ? s.qrPng : undefined,
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
