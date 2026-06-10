/**
 * PR-S2: 推草稿服务 — 用浏览器登录态把视频+文案自动传到平台创作后台并存草稿
 *
 * 抖音: creator.douyin.com/creator-micro/content/upload → 选文件 → 填文案 → 存草稿
 * 视频号(PR-S3 接入): channels.weixin.qq.com 同框架
 *
 * 设计:
 * - 内存任务队列, 全局串行(同时只跑一个浏览器上传, 控资源+控风控节奏)
 * - 账号间随机间隔 8-20s, 模拟人工节奏
 * - 每账号成功 → content_publish_log upsert status="draft" initiatedBy="auto"
 * - 失败自动截图存 data/uploads/draft-push-fail-*.png 方便排查选择器变化
 * - 登录态被踢(回到登录页) → markLoginExpired, 前端提示重新扫码
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "puppeteer";
import { eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, platformAccounts, contentPublishLog } from "../../models/schema.js";
import { access } from "node:fs/promises";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { loadLoginState, markLoginExpired, getSessionBrowser } from "./browser-session.js";
import { generateDouyinCaptionVariants } from "./douyin-caption.js";

// ===== 任务模型 =====
export type DraftPushAccountStatus = "queued" | "running" | "success" | "failed" | "login_expired";

interface DraftPushJob {
  jobId: string;
  tenantId: string;
  contentId: string;
  accounts: Array<{
    accountId: string;
    accountName: string;
    platform: string;
    status: DraftPushAccountStatus;
    error?: string;
  }>;
  createdAt: number;
}

const jobs = new Map<string, DraftPushJob>();
let queueRunning = false;
const pendingJobs: DraftPushJob[] = [];

const FAIL_SHOT_DIR = resolve(process.cwd(), "data/uploads");

function rand(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

// ===== 平台上传实现 =====
interface UploadParams {
  page: Page;
  videoPath: string;
  caption: string;
}

/** 抖音创作者中心: 上传 → 等转码 → 填文案 → 存草稿 (选择器多套兜底) */
async function douyinPushDraft({ page: initialPage, videoPath, caption }: UploadParams): Promise<void> {
  let page = initialPage;
  await page.goto("https://creator.douyin.com/creator-micro/content/upload", {
    waitUntil: "domcontentloaded", // 创作页长连接, networkidle2 永不触发
    timeout: 60_000,
  });
  await new Promise((r) => setTimeout(r, 3_000));
  if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");

  // 1. 确保在上传页 (直链可能被重定向回首页), 再上传
  page = await douyinEnsureUploadPage(page);
  // 抖音是弹窗登录(不改URL): 出现扫码/登录弹窗 = 登录态失效
  const loginPopup = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const txt = (doc.body?.innerText || "");
    // 真上传页不含"扫码登录/验证码登录"对话框文案; 出现即登录态失效弹了登录框
    return /扫码登录|验证码登录|手机号登录|登录后即可|登录抖音/.test(txt);
  }).catch(() => false);
  if (loginPopup) throw new Error("LOGIN_EXPIRED");
  await uploadVideoFile(page, videoPath);
  logger.info("抖音推草稿: 视频文件已提交, 等待进入编辑页");

  // 2. 等编辑页就绪 (出现文案编辑器). 抖音编辑器是 contenteditable
  const editorSelectors = [
    'div[data-placeholder]',
    '.zone-container [contenteditable="true"]',
    '[contenteditable="true"]',
  ];
  let editor: any = null;
  for (const sel of editorSelectors) {
    editor = await page.waitForSelector(sel, { timeout: 90_000 }).catch(() => null);
    if (editor) break;
  }
  if (!editor) throw new Error("等不到文案编辑器 (上传可能失败或页面改版)");

  // 3. 填文案
  await editor.click();
  await page.keyboard.type(caption, { delay: 30 });
  await new Promise((r) => setTimeout(r, 1_500));

  // 4. 等视频转码完成 (存草稿按钮可点). 轮询找"存草稿"按钮并等它非 disabled
  const clicked = await clickButtonByText(page, ["存草稿", "保存草稿"], 180_000);
  if (!clicked) throw new Error("找不到或点不动「存草稿」按钮 (转码超时或页面改版)");

  // 5. 确认结果: 跳转到内容管理 或 出现成功提示
  await new Promise((r) => setTimeout(r, 5_000));
  const url = page.url();
  if (url.includes("login")) throw new Error("LOGIN_EXPIRED");
  logger.info({ url }, "抖音推草稿: 已点击存草稿");
}

/** 文本找按钮并点击 (等到可点为止), 浏览器上下文执行 */
/**
 * 上传视频文件 — 通吃标准 input 和自定义上传组件:
 * 1. 先跨 frame 找现成 input[type=file] 直接 uploadFile
 * 2. 找不到 → 点"上传/添加/选择视频"等区域, 用 waitForFileChooser 拦截原生文件框塞文件
 *    (自定义组件点击后也会弹文件框, 这招绕过 DOM 选择器)
 */
const UPLOAD_TRIGGER_TEXTS = ["上传视频", "上传", "选择视频", "点击上传", "添加视频", "添加", "发布视频"];

async function tryDirectInput(page: Page, videoPath: string): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      // pierce: 既查普通 DOM 也查 shadow root (视频号微前端用 web component)
      const h = await frame.evaluateHandle(() => {
        const doc = (globalThis as any).document;
        function* deep(root: any): any {
          const els = root.querySelectorAll("*");
          for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
        }
        for (const el of deep(doc)) {
          if (el.tagName === "INPUT" && el.type === "file") return el;
        }
        return null;
      });
      const el = h.asElement();
      if (el) { await (el as any).uploadFile(videoPath); await h.dispose(); return true; }
      await h.dispose();
    } catch { /* frame detach */ }
  }
  return false;
}

async function uploadVideoFile(page: Page, videoPath: string): Promise<void> {
  // 诊断: 打印 frame URL 便于排查
  logger.info({ frames: page.frames().map((f) => f.url()).slice(0, 8) }, "推草稿: 当前页 frames");

  if (await tryDirectInput(page, videoPath)) {
    logger.info("推草稿: 直接 input[type=file] 上传成功");
    return;
  }

  // 深度点击: 穿透 shadow DOM + 遍历所有 frame 找上传区点击 (返回命中描述)
  const deepClickUploadZone = async (): Promise<string | null> => {
    for (const frame of page.frames()) {
      try {
        const hit = await frame.evaluate((labels: string[]) => {
          const doc = (globalThis as any).document;
          function* deep(root: any): any {
            const els = root.querySelectorAll("*");
            for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
          }
          const all = Array.from(deep(doc)) as any[];
          const visible = (el: any) => { try { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20; } catch { return false; } };
          // a) class 含 upload/drag
          const classRe = /(upload|uploader|dragger|drag|drop)/i;
          for (const el of all) {
            const cls = el.className && el.className.toString ? el.className.toString() : "";
            if (classRe.test(cls) && visible(el)) { el.click(); return "cls:" + cls.slice(0, 24); }
          }
          // b) 文案含上传/拖拽/大小限制 (上传区提示文字)
          for (const el of all) {
            const t = (el.textContent || "").trim();
            if (t.length < 60 && /上传视频|点击上传|拖拽|选择视频|添加视频|大小不超过|时长/.test(t) && visible(el)) {
              el.click(); return "txt:" + t.slice(0, 18);
            }
          }
          // c) 短按钮精确文本
          for (const el of all) {
            const t = (el.textContent || "").trim();
            if (t.length <= 12 && labels.some((l) => t === l) && visible(el)) { el.click(); return "btn:" + t; }
          }
          return null;
        }, UPLOAD_TRIGGER_TEXTS);
        if (hit) return hit;
      } catch { /* frame detach */ }
    }
    return null;
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    let chooser: any = null;
    const chooserP = page.waitForFileChooser({ timeout: 9_000 }).then((c) => (chooser = c)).catch(() => null);
    const clicked = await deepClickUploadZone();
    await chooserP;
    if (chooser) {
      await chooser.accept([videoPath]);
      logger.info({ via: clicked }, "推草稿: 经 fileChooser 上传成功");
      return;
    }
    logger.info({ attempt, clicked, url: page.url() }, "推草稿: 本轮未触发文件框, 重试");
    // 点击可能触发了导航或动态创建了 input, 再查一次
    if (await tryDirectInput(page, videoPath)) { logger.info("推草稿: 点击后 input 上传成功"); return; }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("找不到上传入口 (input 与 fileChooser 均失败, 见失败截图)");
}

/** 抖音: 确保在上传页 (直链常被重定向回首页 → 从首页点'发布视频'进上传页, 处理可能的新标签页) */
async function douyinEnsureUploadPage(page: Page): Promise<Page> {
  if (/content\/(upload|publish)/.test(page.url())) return page;
  logger.info({ url: page.url() }, "抖音: 不在上传页, 尝试点'发布视频'进入");
  const browser = page.browser();
  const newPagePromise = new Promise<Page | null>((resolve) => {
    const onTarget = async (t: any) => {
      try { const np = await t.page(); if (np) resolve(np); } catch { resolve(null); }
    };
    browser.once("targetcreated", onTarget);
    setTimeout(() => resolve(null), 8_000);
  });
  const clicked = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const els = Array.from(doc.querySelectorAll("a, button, div, span")) as any[];
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (t === "发布视频" || t === "上传视频" || t === "发布作品") { el.click(); return t; }
    }
    return null;
  });
  if (!clicked) {
    // 兜底再直链一次
    await page.goto("https://creator.douyin.com/creator-micro/content/upload", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    return page;
  }
  const newPage = await newPagePromise;
  if (newPage) {
    await newPage.bringToFront().catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    logger.info({ url: newPage.url() }, "抖音: 发布视频打开新标签页");
    return newPage;
  }
  // 同标签内导航
  await new Promise((r) => setTimeout(r, 3_000));
  return page;
}

async function clickButtonByText(page: Page, texts: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((labels: string[]) => {
      const doc = (globalThis as any).document;
      const btns = Array.from(doc.querySelectorAll("button, div[role='button'], span")) as any[];
      for (const b of btns) {
        const t = (b.textContent || "").trim();
        if (!labels.some((l) => t === l)) continue;
        const el = b.closest("button") || b;
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true" ||
          (el.className || "").toString().includes("disabled");
        if (disabled) return false;
        el.click();
        return true;
      }
      return false;
    }, texts);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

/** 视频号助手 (channels.weixin.qq.com): 发表页 → 上传 → 填描述 → 存草稿 */
async function wechatVideoPushDraft({ page, videoPath, caption }: UploadParams): Promise<void> {
  await page.goto("https://channels.weixin.qq.com/platform/post/create", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await new Promise((r) => setTimeout(r, 3_000));
  if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");

  // 1. 选文件 — fileChooser 通吃自定义上传组件
  await uploadVideoFile(page, videoPath);
  logger.info("视频号推草稿: 视频文件已提交");

  // 2. 等描述输入框 (视频号短描述是 contenteditable / textarea)
  const editorSelectors = [
    '.input-editor[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea[placeholder*="描述"]',
    'textarea',
  ];
  let editor: any = null;
  for (const sel of editorSelectors) {
    editor = await page.waitForSelector(sel, { timeout: 90_000 }).catch(() => null);
    if (editor) break;
  }
  if (!editor) throw new Error("等不到描述编辑器 (上传失败或页面改版)");

  // 3. 填描述
  await editor.click();
  await page.keyboard.type(caption, { delay: 30 });
  await new Promise((r) => setTimeout(r, 1_500));

  // 4. 等转码完成后存草稿 ("保存草稿"/"暂存"/"存草稿")
  const clicked = await clickButtonByText(page, ["保存草稿", "暂存", "存草稿", "保存"], 180_000);
  if (!clicked) throw new Error("找不到或点不动「保存草稿」按钮 (转码超时或页面改版)");

  await new Promise((r) => setTimeout(r, 5_000));
  if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");
  logger.info({ url: page.url() }, "视频号推草稿: 已点击保存草稿");
}

const PLATFORM_PUSHERS: Record<string, (p: UploadParams) => Promise<void>> = {
  douyin: douyinPushDraft,
  wechat_video: wechatVideoPushDraft,
};

// ===== 队列执行 =====
/**
 * 视频源 → 本地文件路径。
 * - /storage/xxx (LocalStorage 相对URL, DVH视频就是这种) → 直接映射磁盘路径 (UPLOAD_DIR/storage/xxx), 零拷贝
 * - http(s) → 下载到临时文件 (isTemp=true, 用完删)
 * 复用 video/composer.ts materialize 同一 idiom (红线#11)
 */
async function resolveVideoSource(source: string): Promise<{ path: string; isTemp: boolean }> {
  if (source.startsWith("/storage/")) {
    const relativePath = source.replace("/storage/", "");
    const diskPath = resolve(env.UPLOAD_DIR, "storage", relativePath);
    try {
      await access(diskPath);
      return { path: diskPath, isTemp: false };
    } catch {
      throw new Error(`本地存储文件不存在: ${diskPath} (原始: ${source})`);
    }
  }
  if (/^https?:\/\//i.test(source)) {
    const path = resolve(tmpdir(), `draft-push-${randomUUID()}.mp4`);
    const resp = await fetch(source);
    if (!resp.ok || !resp.body) throw new Error(`视频下载失败: ${resp.status}`);
    await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(path));
    return { path, isTemp: true };
  }
  throw new Error(`无法识别的视频源: ${source.slice(0, 80)}`);
}

// 平台登录态所在 origin (注入 localStorage 需先停在该域页面)
const PLATFORM_ORIGIN: Record<string, string> = {
  douyin: "https://creator.douyin.com",
  wechat_video: "https://channels.weixin.qq.com",
};

async function setPageLoginState(page: Page, state: { cookies: any[]; localStorage?: string }, platform: string) {
  const cdp = await page.target().createCDPSession();
  // CDP setCookies 支持跨域批量
  await cdp.send("Network.setCookies", { cookies: state.cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
    expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  })) });

  // 关键: 恢复 localStorage — 抖音/视频号部分登录令牌存这里, 只给 cookie 会被判未登录弹登录框。
  // localStorage 是 per-origin 的, 必须先停在该域的页面才能写。
  const origin = PLATFORM_ORIGIN[platform];
  if (state.localStorage && state.localStorage !== "{}" && origin) {
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.evaluate((lsJson: string) => {
        try {
          const data = JSON.parse(lsJson);
          const ls = (globalThis as any).localStorage;
          for (const k of Object.keys(data)) ls.setItem(k, data[k]);
        } catch { /* noop */ }
      }, state.localStorage);
      logger.info({ platform }, "推草稿: localStorage 已恢复");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, platform }, "推草稿: localStorage 恢复失败(继续)");
    }
  }
}

async function runJob(job: DraftPushJob) {
  // 取内容 + 视频 URL
  const [content] = await db
    .select()
    .from(contents)
    .where(eq(contents.id, job.contentId))
    .limit(1);
  const videoUrl = content?.type === "video" ? content.body : null;
  if (!content || !videoUrl) {
    for (const a of job.accounts) { a.status = "failed"; a.error = "内容不存在或不是视频"; }
    return;
  }

  let videoPath: string | null = null;
  let videoIsTemp = false;
  try {
    const resolved = await resolveVideoSource(videoUrl);
    videoPath = resolved.path;
    videoIsTemp = resolved.isTemp;
  } catch (err) {
    for (const a of job.accounts) { a.status = "failed"; a.error = err instanceof Error ? err.message : "视频获取失败"; }
    return;
  }

  // 文案: 复用差异化文案生成 (按账号序号对应, 与前端助手一致)
  let captions: string[] = [];
  try {
    const variants = await generateDouyinCaptionVariants({
      contentId: job.contentId,
      tenantId: job.tenantId,
      count: Math.min(job.accounts.length, 10),
      force: false,
      platform: (job.accounts[0]?.platform === "wechat_video" ? "wechat_video" : "douyin") as any,
    });
    captions = variants.map((v: any) => v.fullText || v.hookTitle || content.title || "");
  } catch {
    captions = job.accounts.map(() => content.title || "");
  }

  try {
    for (let i = 0; i < job.accounts.length; i++) {
      const acct = job.accounts[i];
      const pusher = PLATFORM_PUSHERS[acct.platform];
      if (!pusher) { acct.status = "failed"; acct.error = `平台 ${acct.platform} 暂不支持推草稿`; continue; }

      const state = await loadLoginState(acct.accountId, job.tenantId);
      if (!state) { acct.status = "login_expired"; acct.error = "未登录或登录态失效, 请先扫码登录"; continue; }

      acct.status = "running";
      const b = await getSessionBrowser();
      const page = await b.newPage();
      try {
        await page.setViewport({ width: 1366, height: 900 });
        await setPageLoginState(page, state, acct.platform);
        await pusher({ page, videoPath, caption: captions[i] ?? captions[0] ?? "" });
        acct.status = "success";
        // 落库: status=draft (人工在平台后台审核发布后, 前端勾"已发"会覆盖成 success)
        await db.insert(contentPublishLog).values({
          tenantId: job.tenantId,
          contentId: job.contentId,
          accountId: acct.accountId,
          status: "draft",
          initiatedBy: "auto",
        }).onConflictDoUpdate({
          target: [contentPublishLog.contentId, contentPublishLog.accountId],
          set: { status: "draft", initiatedBy: "auto", updatedAt: new Date() },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "推送失败";
        if (msg === "LOGIN_EXPIRED") {
          acct.status = "login_expired";
          acct.error = "登录态已失效, 请重新扫码登录";
          await markLoginExpired(acct.accountId, job.tenantId);
        } else {
          acct.status = "failed";
          acct.error = msg;
          // 失败截图留证
          try {
            await mkdir(FAIL_SHOT_DIR, { recursive: true });
            const shot = resolve(FAIL_SHOT_DIR, `draft-push-fail-${acct.accountId.slice(0, 8)}-${Date.now()}.png`);
            await page.screenshot({ path: shot as any, fullPage: true });
            logger.warn({ shot, accountId: acct.accountId }, "推草稿失败, 已截图");
          } catch { /* noop */ }
        }
        logger.error({ err: msg, accountId: acct.accountId, contentId: job.contentId }, "推草稿失败");
      } finally {
        try { await page.close(); } catch { /* noop */ }
      }

      // 账号间随机间隔, 模拟人工节奏 (最后一个不等)
      if (i < job.accounts.length - 1) {
        await new Promise((r) => setTimeout(r, rand(8_000, 20_000)));
      }
    }
  } finally {
    if (videoPath && videoIsTemp) { try { await unlink(videoPath); } catch { /* noop */ } }
  }
}

async function pumpQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (pendingJobs.length > 0) {
      const job = pendingJobs.shift()!;
      try {
        await runJob(job);
      } catch (err) {
        logger.error({ err, jobId: job.jobId }, "推草稿任务异常");
        for (const a of job.accounts) {
          if (a.status === "queued" || a.status === "running") {
            a.status = "failed";
            a.error = "任务异常中断";
          }
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

// ===== 对外 API =====
export async function enqueueDraftPush(params: {
  tenantId: string;
  contentId: string;
  accounts: Array<{ accountId: string; accountName: string; platform: string }>;
}): Promise<{ jobId: string }> {
  const job: DraftPushJob = {
    jobId: randomUUID(),
    tenantId: params.tenantId,
    contentId: params.contentId,
    accounts: params.accounts.map((a) => ({ ...a, status: "queued" as const })),
    createdAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  pendingJobs.push(job);
  void pumpQueue();
  // 完成 30 分钟后清理
  setTimeout(() => jobs.delete(job.jobId), 1_800_000).unref?.();
  return { jobId: job.jobId };
}

export function getDraftPushJob(jobId: string, tenantId: string): DraftPushJob | null {
  const job = jobs.get(jobId);
  if (!job || job.tenantId !== tenantId) return null;
  return job;
}
