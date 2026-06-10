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
async function douyinPushDraft({ page, videoPath, caption }: UploadParams): Promise<void> {
  await page.goto("https://creator.douyin.com/creator-micro/content/upload", {
    waitUntil: "networkidle2",
    timeout: 60_000,
  });
  if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");

  // 1. 选文件 — 上传页有 input[type=file]
  const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 20_000 });
  if (!fileInput) throw new Error("找不到上传入口 input[type=file]");
  await (fileInput as any).uploadFile(videoPath);
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

const PLATFORM_PUSHERS: Record<string, (p: UploadParams) => Promise<void>> = {
  douyin: douyinPushDraft,
  // wechat_video: PR-S3
};

// ===== 队列执行 =====
async function downloadVideo(url: string): Promise<string> {
  const path = resolve(tmpdir(), `draft-push-${randomUUID()}.mp4`);
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`视频下载失败: ${resp.status}`);
  await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(path));
  return path;
}

async function setPageLoginState(page: Page, state: { cookies: any[] }) {
  const cdp = await page.target().createCDPSession();
  // CDP setCookies 支持跨域批量
  await cdp.send("Network.setCookies", { cookies: state.cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/",
    expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  })) });
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
  try {
    videoPath = await downloadVideo(videoUrl);
  } catch (err) {
    for (const a of job.accounts) { a.status = "failed"; a.error = err instanceof Error ? err.message : "视频下载失败"; }
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
        await setPageLoginState(page, state);
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
    if (videoPath) { try { await unlink(videoPath); } catch { /* noop */ } }
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
