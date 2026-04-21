/**
 * HTML → PNG 卡片渲染器
 *
 * 用 Puppeteer 把 {{var}} 模板渲染为 1080x1920 竖屏 PNG。
 * 用于视频场景的卡片图：开场 / 数据 / 审稿 / 方向 / 建议 / CTA。
 *
 * 约束：
 *  - 浏览器实例懒加载，全进程复用（launch 很慢）
 *  - executablePath 默认 /usr/bin/chromium-browser，可由 PUPPETEER_EXECUTABLE_PATH 覆盖
 *    本地不存在该路径时回退到 puppeteer 打包的 Chromium（利于 Mac 开发）
 */

import puppeteer, { type Browser } from "puppeteer";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "../../config/logger.js";

export type SceneType = "opening" | "data" | "review" | "topic" | "tips" | "cta";

/** 渲染期刊卡片需要的数据。所有字段可选，缺失用占位符显示。 */
export interface JournalCardData {
  name: string;
  nameEn?: string | null;
  impactFactor?: number | null;
  citeScore?: number | null;
  partition?: string | null;            // Q1/Q2/Q3/Q4
  casPartition?: string | null;         // 中科院分区：医学2区 等
  reviewCycle?: string | null;          // "6-8 周" 类字符串
  acceptanceRate?: number | null;       // 接受 0-1 或 0-100，自动归一
  annualVolume?: number | null;
  timeToFirstDecisionDays?: number | null;
  publisher?: string | null;
  discipline?: string | null;
  scopeDescription?: string | null;
  /** 收稿方向标签，用于 topic 场景。不传则显示"暂无数据" */
  topics?: string[];
  /** 投稿建议编号列表，用于 tips 场景。不传用通用兜底 */
  tips?: string[];
  /** CTA 副标题（自定义否则按期刊名生成） */
  ctaSubtitle?: string;
  /** 公众号/账号 handle */
  contactHandle?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_DIR = pathResolve(__dirname, "./templates");

let _browser: Browser | null = null;
const _templateCache = new Map<string, string>();
let _baseCss: string | null = null;

async function resolveExecutablePath(): Promise<string | undefined> {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
  try {
    await access(configured);
    return configured;
  } catch {
    return undefined;
  }
}

async function getBrowser(): Promise<Browser> {
  if (_browser && (_browser as any).connected !== false) return _browser;
  _browser = null;
  const executablePath = await resolveExecutablePath();
  logger.info({ executablePath: executablePath ?? "bundled" }, "Puppeteer 浏览器启动中");
  _browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
  }
}

async function loadTemplate(name: string): Promise<string> {
  const cached = _templateCache.get(name);
  if (cached) return cached;
  const html = await readFile(join(TEMPLATE_DIR, `${name}.html`), "utf8");
  _templateCache.set(name, html);
  return html;
}

async function loadBaseCss(): Promise<string> {
  if (_baseCss) return _baseCss;
  _baseCss = await readFile(join(TEMPLATE_DIR, "_base.css"), "utf8");
  return _baseCss;
}

function htmlEscape(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** {{var}} 转义输出，{{{var}}} 原样输出（用于预构建的 HTML 片段） */
function interpolate(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/\{\{(\{?)(\w+)\1\}\}/g, (_, brace: string, key: string) => {
    const v = data[key];
    if (brace) return v == null ? "" : String(v);
    return htmlEscape(v);
  });
}

/**
 * 将模板渲染为 PNG，返回本地绝对路径。
 * 调用方负责在使用后清理该临时文件（或依赖 OS 清理 tmpdir）。
 */
export async function renderCard(
  templateName: SceneType,
  data: Record<string, unknown>,
): Promise<string> {
  const [tpl, css] = await Promise.all([loadTemplate(templateName), loadBaseCss()]);
  let html = interpolate(tpl, data);
  // 把 <link href="_base.css"> 替换为内联 style，避免浏览器再去加载外部文件
  html = html.replace(
    /<link[^>]*rel="stylesheet"[^>]*href="_base\.css"[^>]*\/?>/,
    `<style>${css}</style>`,
  );

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    // 等字体加载完再截图，否则中文可能显示为 fallback 字体
    await page.evaluate(async () => {
      const d = document as any;
      if (d.fonts?.ready) await d.fonts.ready;
    });
    const buf = await page.screenshot({ type: "png", fullPage: false });
    const outPath = join(tmpdir(), `bossmate-card-${randomUUID()}.png`);
    await writeFile(outPath, buf as Buffer);
    return outPath;
  } finally {
    await page.close().catch(() => {});
  }
}

// ============ 数据格式化辅助 ============

function fmtNumber(v: number | null | undefined, decimals = 2): string {
  if (v == null || !isFinite(v)) return "—";
  // 去掉小数部分末尾多余的 0：3.20 → 3.2，3.00 → 3，整数部分不动
  return Number(v)
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function fmtPercent(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  // 数据库可能存 0-1（0.28）或 0-100（28.0），自动归一
  const n = v > 1 ? v : v * 100;
  return fmtNumber(n, 1);
}

function fmtInt(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return String(Math.round(v));
}

function fmtText(v: string | null | undefined, fallback = "—"): string {
  const s = v?.trim();
  return s ? s : fallback;
}

function buildTopicsHtml(topics: string[] | undefined): string {
  if (!topics || topics.length === 0) {
    return `<span class="topic-pill">暂无收稿方向数据</span>`;
  }
  return topics
    .slice(0, 8)
    .map((t, i) => {
      const cls = i % 3 === 1 ? "topic-pill accent" : "topic-pill";
      return `<span class="${cls}">${htmlEscape(t)}</span>`;
    })
    .join("\n");
}

function buildTipsHtml(tips: string[] | undefined): string {
  const fallback = [
    "对照期刊 Author Guidelines 检查格式、字数、参考文献规范。",
    "Cover Letter 突出研究创新点与期刊 Scope 的匹配度。",
    "投稿前先内部盲审一轮，避免低级错误直接被拒。",
    "合理建议 2-3 位审稿人，避免明显利益冲突。",
  ];
  const list = (tips && tips.length > 0 ? tips : fallback).slice(0, 4);
  return list
    .map(
      (t, i) => `<div class="tip-card"><div class="tip-num">${i + 1}</div><div class="tip-body">${htmlEscape(t)}</div></div>`,
    )
    .join("\n");
}

/**
 * 高层入口：根据场景类型 + 期刊数据渲染对应卡片 PNG
 */
export async function generateCard(
  sceneType: SceneType,
  data: JournalCardData,
): Promise<string> {
  const vars: Record<string, unknown> = {
    journalName: fmtText(data.name, "未知期刊"),
    journalNameEn: fmtText(data.nameEn, ""),
    impactFactor: fmtNumber(data.impactFactor, 2),
    citeScore: fmtNumber(data.citeScore, 1),
    partition: fmtText(data.partition),
    casPartition: fmtText(data.casPartition),
    reviewCycle: fmtText(data.reviewCycle),
    acceptanceRate: fmtPercent(data.acceptanceRate),
    annualVolume: fmtInt(data.annualVolume),
    timeToFirstDecision: fmtInt(data.timeToFirstDecisionDays),
    publisher: fmtText(data.publisher),
    discipline: fmtText(data.discipline),
    scopeDescription: fmtText(data.scopeDescription, ""),
    contactHandle: fmtText(data.contactHandle, "BossMate 学术"),
    ctaSubtitle:
      data.ctaSubtitle ||
      `关注我们，获取 ${data.name || "更多 SCI 期刊"} 的投稿指南与审稿动态`,
    topicsHtml: buildTopicsHtml(data.topics),
    tipsHtml: buildTipsHtml(data.tips),
  };
  return renderCard(sceneType, vars);
}
