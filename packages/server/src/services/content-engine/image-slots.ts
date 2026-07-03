/**
 * 7-03 图文模板重构②：图位标记 → 真实图表/封面 的后处理（老韩反馈"一小段文字配点图"）。
 *
 * 机制：
 *   1. 生成 prompt 侧（article-skill）用 buildImageSlotPromptBlock() 告诉 LLM 本刊真有哪些图位，
 *      LLM 在短段落之间插 {{IMG:xxx}} 标记（每 2-3 小段一个，全文 3-5 个，不重复）。
 *   2. 后处理侧用 applyImageSlots() 把标记替换为真实 <img>/表格：
 *      - cover     → coverUrlHd || coverImageUrl || coverUrl 外链 <img>
 *      - if_trend  → journal-chart-generator.generateIFTrendChart → SVG data URI（shunshi 同款做法）
 *      - pub_volume→ generatePubVolumeChart → SVG data URI
 *      - cas_table → generateCASPartitionTable（HTML 表格）
 *      - jcr_table → generateJCRPartitionTable（HTML 表格）
 *      优雅降级：该刊没数据的图位 / LLM 编造的未知标记 → 整个标记删除（含独占 <p> 的空壳）。
 *      幂等 + 去重：同一图位已插入过（<!--img-slot:x--> 签名）→ 后续标记删除，不重复出图。
 *
 * 接线：quality-pipeline（压缩/禁词之后、六维质检之前）+ article-skill 模板组装后（双保险，
 *       交互路径不走 pipeline 也不会漏字面标记）。纯函数，journal 形状容错（DB row / JournalInfo 均可）。
 */
import {
  generateIFTrendChart,
  generatePubVolumeChart,
  generateCASPartitionTable,
  generateJCRPartitionTable,
  svgToDataUri,
} from "../crawler/journal-chart-generator.js";

export type ImageSlotKey = "cover" | "if_trend" | "pub_volume" | "cas_table" | "jcr_table";

export const IMAGE_SLOT_LABELS: Record<ImageSlotKey, string> = {
  cover: "期刊封面",
  if_trend: "近10年影响因子趋势图",
  pub_volume: "近10年发文量图",
  cas_table: "中科院分区表",
  jcr_table: "JCR 分区表",
};

/** journal 形状容错：DB journals row（jsonb 字段）和 collector JournalInfo 都能喂 */
export type ImageSlotJournalLike = Record<string, unknown> | null | undefined;

const MARKER_RE = /\{\{\s*IMG\s*:\s*([a-zA-Z_]+)\s*\}\}/g;
/** 标记独占一个 <p>（模板路径 LLM 常把标记单独写一段）→ 整段替换，不留空 <p> 壳 */
const MARKER_P_RE = /<p\b[^>]*>\s*\{\{\s*IMG\s*:\s*([a-zA-Z_]+)\s*\}\}\s*<\/p>/gi;

// ============ journal 数据归一化（DB jsonb / JournalInfo 双形态） ============

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function normIfHistory(j: ImageSlotJournalLike): Array<{ year: number; value: number }> {
  if (!j) return [];
  const cands: unknown[] = [j["promptIfHistory"], j["ifHistory"]];
  for (const c of cands) {
    const arr = Array.isArray(c) ? c : (c && typeof c === "object" && Array.isArray((c as { data?: unknown[] }).data) ? (c as { data: unknown[] }).data : null);
    if (!arr || arr.length === 0) continue;
    const out: Array<{ year: number; value: number }> = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const year = num(o.year);
      const value = num(o.value ?? o.if);
      if (year != null && value != null && value > 0) out.push({ year, value });
    }
    if (out.length > 0) return out.sort((a, b) => a.year - b.year);
  }
  return [];
}

function normPubVolume(j: ImageSlotJournalLike): Array<{ year: number; count: number }> {
  if (!j) return [];
  const stats = (j["publicationStats"] ?? j["promptPublicationStats"]) as { annualVolumeHistory?: unknown[] } | null | undefined;
  const cands: unknown[] = [j["pubVolumeHistory"], stats?.annualVolumeHistory];
  for (const c of cands) {
    if (!Array.isArray(c) || c.length === 0) continue;
    const out: Array<{ year: number; count: number }> = [];
    for (const it of c) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const year = num(o.year);
      const count = num(o.count ?? o.value);
      if (year != null && count != null && count > 0) out.push({ year, count });
    }
    if (out.length > 0) return out.sort((a, b) => a.year - b.year);
  }
  return [];
}

interface CasPartitionData {
  version: string;
  publishDate?: string;
  majorCategory: string;
  subCategories: Array<{ zone: string; subject: string }>;
  isTop: boolean;
  isReview: boolean;
}

/** "3区材料科学"/"工程技术2区" → { zone, subject }（保留 DB 原文语序拆 zone） */
function splitZoneSubject(s: string): { zone: string; subject: string } | null {
  const m = s.match(/([1-4]\s*区)/);
  if (!m) return null;
  const zone = m[1].replace(/\s+/g, "");
  const subject = s.replace(m[1], "").trim() || s;
  return { zone, subject };
}

function normCasPartitions(j: ImageSlotJournalLike): CasPartitionData[] {
  if (!j) return [];
  // LetPub 结构化数据优先（shunshi/V7 同源）
  const letpub = j["letpubCasPartitions"];
  if (Array.isArray(letpub) && letpub.length > 0) {
    return letpub.filter((p): p is CasPartitionData => !!p && typeof p === "object" && typeof (p as CasPartitionData).majorCategory === "string" && Array.isArray((p as CasPartitionData).subCategories));
  }
  // 兜底：casPartition / casPartitionNew 纯字符串（DB 真值，原文拆分渲染）
  const out: CasPartitionData[] = [];
  const jcrFull = (j["jcrFull"] ?? j["promptJcrFull"]) as { isTopJournal?: boolean; isReviewJournal?: boolean } | null | undefined;
  for (const [field, version] of [["casPartition", "中科院分区（基础版）"], ["casPartitionNew", "中科院分区（升级版）"]] as const) {
    const raw = j[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const zs = splitZoneSubject(raw.trim());
    if (!zs) continue;
    out.push({
      version,
      majorCategory: zs.subject,
      subCategories: [zs],
      isTop: jcrFull?.isTopJournal === true,
      isReview: jcrFull?.isReviewJournal === true,
    });
  }
  return out;
}

interface JcrPartitionData { subject: string; database: string; zone: string; rank: string }

function normJcrPartitions(j: ImageSlotJournalLike): JcrPartitionData[] {
  if (!j) return [];
  const letpub = j["letpubJcrPartitions"];
  if (Array.isArray(letpub) && letpub.length > 0) {
    return letpub.filter((p): p is JcrPartitionData => !!p && typeof p === "object" && typeof (p as JcrPartitionData).subject === "string" && typeof (p as JcrPartitionData).zone === "string");
  }
  const jcrFull = (j["jcrFull"] ?? j["promptJcrFull"]) as { jifSubjects?: unknown[] } | null | undefined;
  const subjects = jcrFull?.jifSubjects;
  if (Array.isArray(subjects)) {
    const out: JcrPartitionData[] = [];
    for (const it of subjects) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      if (typeof o.subject === "string" && typeof o.zone === "string" && o.zone) {
        out.push({ subject: o.subject, database: typeof o.database === "string" && o.database ? o.database : "SCIE", zone: o.zone, rank: typeof o.rank === "string" && o.rank ? o.rank : "—" });
      }
    }
    return out;
  }
  return [];
}

function coverUrl(j: ImageSlotJournalLike): string | null {
  if (!j) return null;
  for (const f of ["coverUrlHd", "coverImageUrl", "coverUrl"]) {
    const v = j[f];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

// ============ 可用图位 & prompt 块 ============

/** 该刊真有数据的图位清单（prompt 侧只报这些，LLM 编不出别的） */
export function availableImageSlots(j: ImageSlotJournalLike): ImageSlotKey[] {
  const slots: ImageSlotKey[] = [];
  if (coverUrl(j)) slots.push("cover");
  if (normIfHistory(j).length >= 2) slots.push("if_trend");
  if (normPubVolume(j).length >= 2) slots.push("pub_volume");
  if (normCasPartitions(j).length > 0) slots.push("cas_table");
  if (normJcrPartitions(j).length > 0) slots.push("jcr_table");
  return slots;
}

/**
 * 生成 prompt 注入块：告诉 LLM 可用图位 + 插入节奏。无可用图位返回空串（不提图位这回事）。
 */
export function buildImageSlotPromptBlock(j: ImageSlotJournalLike): string {
  const slots = availableImageSlots(j);
  if (slots.length === 0) return "";
  const list = slots.map((s) => `{{IMG:${s}}}（${IMAGE_SLOT_LABELS[s]}）`).join("、");
  const target = Math.min(5, Math.max(2, slots.length));
  return `
【图文交替排版 — 图位标记】本刊有以下真实图片/图表可插入正文：${list}。
- 在段与段之间按内容节奏插入图位标记（标记独占一行/一段），让读者"看一小段文字、看一张图"；
- 每 2-3 小段插 1 个图位，全文插 ${Math.min(3, slots.length)}-${target} 个，同一图位只用一次，不同图不重复；
- 标记放在与它内容相关的段落后面（讲 IF 走势的段落后放 {{IMG:if_trend}}，讲分区的段落后放 {{IMG:cas_table}}）；
- 🚫 只能用上面清单里的标记，严禁自创其它 {{IMG:xxx}}。`;
}

// ============ 渲染 ============

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapBlock(key: ImageSlotKey, inner: string): string {
  return `<section style="margin:14px 0;text-align:center;"><!--img-slot:${key}-->${inner}</section>`;
}

function renderSlot(key: ImageSlotKey, j: ImageSlotJournalLike): string | null {
  switch (key) {
    case "cover": {
      const url = coverUrl(j);
      if (!url) return null;
      return wrapBlock(key, `<img src="${escAttr(url)}" alt="期刊封面" style="display:block;width:56%;max-width:260px;margin:0 auto;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.12);">`);
    }
    case "if_trend": {
      const hist = normIfHistory(j);
      if (hist.length < 2) return null;
      const svg = generateIFTrendChart(hist);
      if (!svg) return null;
      return wrapBlock(key, `<img src="${svgToDataUri(svg)}" alt="近10年影响因子趋势" style="display:block;width:100%;margin:0 auto;">`);
    }
    case "pub_volume": {
      const hist = normPubVolume(j);
      if (hist.length < 2) return null;
      const svg = generatePubVolumeChart(hist);
      if (!svg) return null;
      return wrapBlock(key, `<img src="${svgToDataUri(svg)}" alt="近10年发文量" style="display:block;width:100%;margin:0 auto;">`);
    }
    case "cas_table": {
      const parts = normCasPartitions(j);
      if (parts.length === 0) return null;
      const html = generateCASPartitionTable(parts);
      return html ? wrapBlock(key, html) : null;
    }
    case "jcr_table": {
      const parts = normJcrPartitions(j);
      if (parts.length === 0) return null;
      const html = generateJCRPartitionTable(parts);
      return html ? wrapBlock(key, html) : null;
    }
    default:
      return null;
  }
}

// ============ 主入口：标记替换 + 优雅降级 ============

export interface ApplyImageSlotsResult {
  body: string;
  /** 成功替换成真图的图位 */
  inserted: ImageSlotKey[];
  /** 被删除的标记（没数据/未知标记/重复） */
  dropped: string[];
  changed: boolean;
}

const VALID_KEYS = new Set<string>(["cover", "if_trend", "pub_volume", "cas_table", "jcr_table"]);

/**
 * 把 body 里的 {{IMG:xxx}} 标记替换为真实图/表；没数据或未知/重复的标记直接删除。
 * 幂等：已含 <!--img-slot:x--> 签名的图位不会重复插入。纯函数，无 IO/LLM。
 */
export function applyImageSlots(body: string, journal: ImageSlotJournalLike): ApplyImageSlotsResult {
  if (!body || !body.includes("{{")) {
    return { body: body || "", inserted: [], dropped: [], changed: false };
  }
  const inserted: ImageSlotKey[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  // 已有签名（本函数早前跑过 / article-skill 已替换过）→ 视为已用，pipeline 二次调用不重复出图
  for (const key of VALID_KEYS) {
    if (body.includes(`<!--img-slot:${key}-->`)) seen.add(key);
  }

  const substitute = (marker: string, rawKey: string): string => {
    const key = rawKey.toLowerCase();
    if (!VALID_KEYS.has(key) || seen.has(key)) {
      dropped.push(marker.trim());
      return "";
    }
    const rendered = renderSlot(key as ImageSlotKey, journal);
    if (!rendered) {
      dropped.push(marker.trim());
      return "";
    }
    seen.add(key);
    inserted.push(key as ImageSlotKey);
    return rendered;
  };

  // 先处理独占 <p> 的标记（整段替换，不留空壳），再处理散落的标记
  let out = body.replace(MARKER_P_RE, (m, k: string) => substitute(m, k));
  out = out.replace(MARKER_RE, (m, k: string) => substitute(m, k));

  return { body: out, inserted, dropped, changed: out !== body };
}

/**
 * 7-03 ③：双重转义泄漏修复。正文中出现 `&amp;lt;` / `&amp;amp;` 等二次转义
 * （crawler 存了已转义文本再被 esc()，或 LLM 回写时二次转义），读者会看到
 * "&lt;5%"、"&amp;" 字面。这些序列在本产品正文里永远是转义事故，降一层是安全的。
 * 纯函数；反复调用收敛（每次只降一层，正常文本一次即净）。
 */
export function fixDoubleEscapedEntities(body: string): string {
  if (!body || !body.includes("&amp;")) return body || "";
  return body.replace(/&amp;(lt|gt|amp|quot|#39|nbsp);/g, "&$1;");
}
