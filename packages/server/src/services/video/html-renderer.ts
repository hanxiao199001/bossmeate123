/**
 * HTML Renderer - 用 Puppeteer 渲染 HTML 模板为 1080×1920 PNG
 *
 * 策略：进程级共享 browser 实例，每次渲染创建新 page。
 * 模板路径：packages/server/src/services/video/templates/*.html
 * 变量替换：{{key}} → data[key]
 */

import puppeteer, { type Browser } from "puppeteer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "../../config/logger.js";

export type SceneType = "opening" | "data" | "review" | "topic" | "tips" | "cta";

export interface JournalCardData {
  name?: string | null;
  nameEn?: string | null;
  impactFactor?: number | null;
  casPartition?: string | null;
  casPartitionNew?: string | null;
  partition?: string | null;
  reviewCycle?: string | null;
  acceptanceRate?: number | null;
  selfCitationRate?: number | null;
  citeScore?: number | null;
  jcrSubjects?: string | null;
  scopeDescription?: string | null;
  discipline?: string | null;
  publisher?: string | null;
}

const TEMPLATE_DIR = resolve(process.cwd(), "src/services/video/templates");

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  if (launching) return launching;
  launching = (async () => {
    const b = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none",
        "--hide-scrollbars",
      ],
    });
    logger.info("Puppeteer browser 启动完成");
    b.on("disconnected", () => {
      logger.warn("Puppeteer browser disconnected");
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

export async function closeBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

/** 模板变量替换（简单 {{key}} 占位符） */
function fill(html: string, data: Record<string, string>): string {
  let out = html;
  for (const [k, v] of Object.entries(data)) {
    out = out.split(`{{${k}}}`).join(v ?? "");
  }
  return out;
}

/** HTML 文本转义（用于普通文字字段） */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtIF(v: number | null | undefined): string {
  return v != null ? v.toFixed(3) : "N/A";
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "暂缺";
  return (v > 1 ? v : v * 100).toFixed(1) + "%";
}

function buildSubjectsHtml(jcr: string | null | undefined): string {
  let arr: Array<{ subject: string; rank: string }> = [];
  try {
    const parsed = JSON.parse(jcr || "[]");
    if (Array.isArray(parsed)) {
      arr = parsed.slice(0, 8).map((v: any) => ({
        subject: String(v.subject || "").slice(0, 16),
        rank: String(v.rank || ""),
      }));
    }
  } catch {}
  if (arr.length === 0) {
    return `<span class="subject-tag" style="background:linear-gradient(135deg,#7c4dff,#4a148c)">暂 无 学 科 分 区</span>`;
  }
  const palette = [
    "linear-gradient(135deg,#7c4dff,#4a148c)",
    "linear-gradient(135deg,#e91e63,#880e4f)",
    "linear-gradient(135deg,#00bcd4,#006064)",
    "linear-gradient(135deg,#4caf50,#1b5e20)",
    "linear-gradient(135deg,#ff9800,#e65100)",
    "linear-gradient(135deg,#3f51b5,#1a237e)",
    "linear-gradient(135deg,#f44336,#b71c1c)",
    "linear-gradient(135deg,#9c27b0,#4a148c)",
  ];
  return arr.map((s, i) => {
    const label = (s.rank ? `${s.rank} ` : "") + s.subject;
    return `<span class="subject-tag" style="background:${palette[i % palette.length]}">${escHtml(label)}</span>`;
  }).join("\n      ");
}

/** 把原始期刊数据转成模板所需的字符串字段 */
export function buildTemplateData(d: JournalCardData): Record<string, string> {
  const impactFactor = fmtIF(d.impactFactor);
  const partition = d.casPartitionNew || d.casPartition || d.partition || "";
  const category = (d.discipline || "学术期刊").slice(0, 10);
  const discipline = (d.discipline || "本领域").slice(0, 8);
  const acceptRate = fmtPct(d.acceptanceRate);
  const acceptRateBar = (() => {
    if (d.acceptanceRate == null) return "4%";
    const pct = d.acceptanceRate > 1 ? d.acceptanceRate : d.acceptanceRate * 100;
    return Math.max(4, Math.min(100, pct)).toFixed(1) + "%";
  })();
  const ifBadge = impactFactor !== "N/A" ? `IF ${impactFactor}` : "";
  const badge = [ifBadge, partition].filter(Boolean).join("  ·  ");
  const scope = (d.scopeDescription || "").trim();

  return {
    name: escHtml(d.name || "期刊"),
    nameEn: escHtml((d.nameEn || "").slice(0, 40)),
    impactFactor: escHtml(impactFactor),
    citeScore: escHtml(d.citeScore != null ? d.citeScore.toFixed(1) : "N/A"),
    partition: escHtml(partition || "N/A"),
    category: escHtml(category),
    discipline: escHtml(discipline),
    reviewCycle: escHtml((d.reviewCycle || "暂缺").slice(0, 14)),
    acceptRate: escHtml(acceptRate),
    acceptRateBar,
    selfCitationRate: escHtml(fmtPct(d.selfCitationRate)),
    publisher: escHtml((d.publisher || "暂缺").slice(0, 22)),
    scopeDescription: escHtml(scope ? (scope.length > 180 ? scope.slice(0, 180) + "……" : scope) : "暂无详细收稿范围描述，请访问期刊官网了解完整信息"),
    subjectsHtml: buildSubjectsHtml(d.jcrSubjects),
    badge: escHtml(badge),
  };
}

/**
 * 渲染一张卡片：读模板 → 替换占位符 → Puppeteer 截图 → 返回 PNG Buffer
 */
export async function renderCard(
  templateName: string,
  data: Record<string, string>,
): Promise<Buffer> {
  const templatePath = resolve(TEMPLATE_DIR, `${templateName}.html`);
  const raw = await readFile(templatePath, "utf-8");
  const html = fill(raw, data);

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });
    const bytes = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1080, height: 1920 },
      omitBackground: false,
    });
    return Buffer.from(bytes);
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * 高层 API：输入期刊数据 + sceneType，返回 PNG Buffer
 */
export async function generateCard(type: SceneType, data: JournalCardData): Promise<Buffer> {
  const tplData = buildTemplateData(data);
  return renderCard(type, tplData);
}
