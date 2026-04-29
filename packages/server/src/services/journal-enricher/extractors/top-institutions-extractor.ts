/**
 * top-institutions extractor (B.2.1.B)
 *
 * 从 Scimago search 结果页解析 Top N 高产机构 + 发文数。
 *
 * Scimago search URL: /journalsearch.php?q=<ISSN>
 * 命中单个期刊会立即跳转到该期刊详情页（也可能 search 页带搜索结果链接）。
 * 详情页表格 #institutions（文档 ID 历史变动较多；这里走 cheerio 容错选择器）。
 *
 * 解析策略（按优先级）：
 *  1. <table> 含 thead/th 文本 "Institution" / "Country" → 拿 tbody tr × 5
 *  2. <div class="cellslide"> 内的 listing（旧版页面）
 *  3. <a href*="institutionsearch.php?q="> 锚点（兜底）
 *
 * 输出：TopInstitutionRow[] 或 null（无任何机构 → 让 publication-stats 自决定）。
 *
 * 失败护栏：HTML 不是 Scimago（CF challenge / 服务器 5xx 残留）→ 直接 null，不抛错。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { TopInstitutionRow } from "../types.js";
import { logger } from "../../../config/logger.js";

const MAX_INSTITUTIONS = 5;

export function extractTopInstitutions(html: string | null): TopInstitutionRow[] | null {
  if (!html || html.length < 200) return null;
  // CF challenge 页面 title=Just a moment / 请稍候，正文很小 → 已在 stealth-fetcher 拦截
  // 这里再做一次保险：明显不像 Scimago 直接 null
  if (!/scimagojr|journalsearch|journalsr/i.test(html)) {
    logger.debug("top-institutions: HTML 不像 Scimago，跳过");
    return null;
  }
  const $ = cheerio.load(html);

  // 策略 1: 表格 - 表头含 "Institution"
  const fromTable = parseInstitutionTable($);
  if (fromTable.length > 0) return fromTable.slice(0, MAX_INSTITUTIONS);

  // 策略 2: 旧版 cellslide 列表
  const fromCellslide = parseCellslideList($);
  if (fromCellslide.length > 0) return fromCellslide.slice(0, MAX_INSTITUTIONS);

  // 策略 3: institutionsearch.php?q= 链接锚点
  const fromAnchors = parseInstitutionAnchors($);
  if (fromAnchors.length > 0) return fromAnchors.slice(0, MAX_INSTITUTIONS);

  return null;
}

function parseInstitutionTable($: CheerioAPI): TopInstitutionRow[] {
  const rows: TopInstitutionRow[] = [];
  $("table").each((_, table) => {
    const headerText = $(table).find("thead th, tr:first-child th, tr:first-child td").text().toLowerCase();
    if (!/institution/.test(headerText)) return;
    $(table).find("tbody tr").each((_i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 2) return;
      const name = $(tds[0]).text().trim();
      if (!name) return;
      const row: TopInstitutionRow = { name };
      // 试着读后续 cell：可能是 country / count / percentile
      for (let i = 1; i < tds.length; i++) {
        const cell = $(tds[i]).text().trim();
        const num = Number(cell.replace(/[,\s]/g, ""));
        if (Number.isFinite(num)) {
          // 第一个数字 cell 当 paperCount，第二个当 percentile (若 ≤ 100)
          if (row.paperCount === undefined) row.paperCount = num;
          else if (row.percentile === undefined && num >= 0 && num <= 100) row.percentile = num;
        } else if (cell && !row.country && /^[A-Z][a-zA-Z\s]+$/.test(cell)) {
          row.country = cell;
        }
      }
      rows.push(row);
    });
  });
  return rows;
}

function parseCellslideList($: CheerioAPI): TopInstitutionRow[] {
  const rows: TopInstitutionRow[] = [];
  $(".cellslide a, .cellslide li").each((_, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    // "Harvard University 1234" 这种格式
    const m = text.match(/^(.+?)\s+(\d{1,6})\s*$/);
    if (m) {
      rows.push({ name: m[1].trim(), paperCount: Number(m[2]) });
    } else if (text.length < 200) {
      rows.push({ name: text });
    }
  });
  return rows;
}

function parseInstitutionAnchors($: CheerioAPI): TopInstitutionRow[] {
  const rows: TopInstitutionRow[] = [];
  const seen = new Set<string>();
  $('a[href*="institutionsearch.php?q="]').each((_, a) => {
    const name = $(a).text().trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    rows.push({ name });
  });
  return rows;
}
