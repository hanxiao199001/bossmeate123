/**
 * 顺仕美途风格期刊推荐模板（T4-3-X "shunshi-style"）
 *
 * 视觉对齐参考：顺仕美途科研服务平台 公众号 截图（用户提供 4 张原图）。
 * 风格定位：标准期刊推荐排版，13 区块结构 + 数据可视化 + 红蓝白配色，权威感最强。
 *
 * 配色 / 字号契约：
 *  - 红色 #DC143C / #E60012  →  期刊英文名 / 期刊简称 / 红色关键标题
 *  - 蓝色 #1976D2 / #1E90FF  →  章节标题 / 链接
 *  - 白底 + 黑色正文 #333    →  正文
 *  - 章节标题 18px / 期刊名 18px / 期刊简称 16px / 红色小标题 16px / 正文 14px / line-height 1.7
 *
 * 13 区块（按渲染顺序）：
 *  1. 顶部钩子标题（数据钩子+痛点）—— 由 article-skill 的 aiContent.title 承载，不在 body 内
 *  2. 居中蓝色「今日期刊推荐」
 *  3. 居中红色 期刊英文全名
 *  4. 居中红色 期刊简称（journal.abbreviation 缺失则跳过）
 *  5. 期刊基本信息（创刊时间 / 出版国家 / 出版商 / ISSN / 期刊官网）
 *  6. 期刊封面图（清晰大图居中）—— 不做虚化背景（用户反馈）
 *  7. 「近10年的影响因子」红色小标题 + 柱状图占位（C 阶段会替换为真柱状图）
 *  8. CAR 指数文字段（占位 N/A，C 阶段补真数据）
 *  9. 「JCR分区」蓝色居中标题 + 新锐分区表 / 期刊分区表 / WOS 分区
 * 10. 「发文情况」蓝色居中标题
 * 11. 发文统计文字段（journal.annualVolume + 国内活跃机构占位）
 * 12. 「近10年的发文量」红色小标题 + 柱状图占位
 * 13. 底部 CTA（综合来看 + 适合人群）
 *
 * 与 'data-card' / 'storytelling' / 'listicle' 互换性：签名完全一致。
 * WeChat 兼容性约束：inline style only / table 布局 / ≥14px / 不用 flex/grid。
 */

import type { JournalInfo, CollectionResult } from "../../data-collection/journal-content-collector.js";
import type { AIGeneratedContent } from "../../skills/journal-template.js";
import { esc } from "../../skills/journal-template.js";

type Abstracts = CollectionResult["abstracts"];

const RED = "#DC143C";
const BLUE = "#1976D2";
const TEXT = "#333";
const MUTED = "#999";

// ============ 区块 2: 居中蓝色"今日期刊推荐" ============
function renderTopRecommendBanner(): string {
  return `<section style="margin:0 0 14px 0;text-align:center;">` +
    `<p style="margin:0;font-size:18px;font-weight:bold;color:${BLUE};line-height:1.5;">今日期刊推荐</p>` +
    `</section>`;
}

// ============ 区块 3: 居中红色 期刊英文全名 ============
function renderJournalNameRed(journal: JournalInfo): string {
  const fullName = journal.nameEn || journal.name;
  return `<section style="margin:0 0 6px 0;text-align:center;">` +
    `<p style="margin:0;font-size:18px;font-weight:bold;color:${RED};line-height:1.5;">${esc(fullName)}</p>` +
    `</section>`;
}

// ============ 区块 4: 居中红色 期刊简称（缺失则跳过） ============
function renderAbbreviation(journal: JournalInfo): string {
  if (!journal.abbreviation) return "";
  return `<section style="margin:0 0 16px 0;text-align:center;">` +
    `<p style="margin:0;font-size:16px;font-weight:bold;color:${RED};line-height:1.5;">${esc(journal.abbreviation)}</p>` +
    `</section>`;
}

// ============ 区块 5: 期刊基本信息 ============
function renderBasicInfo(journal: JournalInfo): string {
  const lines: string[] = [];

  if (journal.foundingYear) {
    lines.push(`<strong>创刊时间：</strong>${esc(String(journal.foundingYear))}年`);
  }
  if (journal.country) {
    lines.push(`<strong>出版国家：</strong>${esc(journal.country)}`);
  }
  if (journal.publisher) {
    lines.push(`<strong>出版商：</strong>${esc(journal.publisher)}`);
  }
  if (journal.issn) {
    lines.push(`<strong>ISSN：</strong>${esc(journal.issn)}`);
  }
  if (journal.website) {
    const safe = esc(journal.website);
    lines.push(`<strong>期刊官方网站：</strong><a href="${safe}" style="color:${BLUE};text-decoration:none;">${safe}</a>`);
  }

  if (lines.length === 0) return "";

  const ps = lines
    .map((l) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">${l}</p>`)
    .join("");

  return `<section style="margin:0 0 18px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
    ps +
    `</section>`;
}

// ============ 区块 6: 期刊封面图（居中大图，不做虚化） ============
function renderCoverImage(journal: JournalInfo): string {
  const cover = journal.coverUrl || (journal as any).coverImageUrl;
  if (!cover) return "";
  const journalName = esc(journal.nameEn || journal.name);
  return `<section style="margin:0 0 22px 0;text-align:center;">` +
    `<img src="${esc(cover)}" alt="${journalName}" style="max-width:100%;height:auto;display:block;margin:0 auto;border-radius:4px;" />` +
    `</section>`;
}

// ============ 区块 7: 「近10年的影响因子」红色标题 + 柱状图占位 ============
function renderIfChartPlaceholder(journal: JournalInfo): string {
  const ifValue = journal.impactFactor != null ? `（最新 IF ${journal.impactFactor}）` : "";
  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:16px;font-weight:bold;color:${RED};text-align:center;line-height:1.5;">近10年的影响因子${esc(ifValue)}</p>` +
    `<div style="border:1px dashed #ccc;padding:30px 16px;text-align:center;color:${MUTED};font-size:14px;line-height:1.7;border-radius:6px;background:#FCFCFC;">` +
      `📊 近 10 年影响因子走势图（数据采集中）` +
    `</div>` +
    `</section>`;
}

// ============ 区块 8: CAR 指数文字段（占位） ============
function renderCarIndexPlaceholder(journal: JournalInfo): string {
  const journalName = esc(journal.nameEn || journal.name);
  return `<section style="margin:0 0 22px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};"><strong style="color:${RED};">CAR 指数：</strong>${journalName} 2026年 N/A，2025年 N/A，2024年 N/A（数据采集中）</p>` +
    `<p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">CAR = Citation Activity Rank，反映期刊近年被引活跃度</p>` +
    `</section>`;
}

// ============ 区块 9: 「JCR分区」蓝色居中标题 + 三张分区表 ============
interface JcrSubject { subject: string; rank: string; position?: string }

function tryParseJcrSubjects(raw: string | null | undefined): JcrSubject[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is JcrSubject => x && typeof x.subject === "string" && typeof x.rank === "string");
  } catch {
    return [];
  }
}

function renderPartitionTable(
  caption: string,
  rows: Array<{ majorCategory: string; subCategory: string; isTop: boolean; isReview: boolean }>
): string {
  const headerCells = ["大类学科", "小类学科", "Top期刊", "综述期刊"]
    .map((h) => `<th style="padding:8px 6px;background:${BLUE};color:#fff;font-size:14px;font-weight:bold;border:1px solid #ddd;text-align:center;">${esc(h)}</th>`)
    .join("");

  const rowsHtml = rows
    .map((r) => {
      const cells = [r.majorCategory, r.subCategory, r.isTop ? "是" : "否", r.isReview ? "是" : "否"];
      return `<tr>${cells
        .map((c) => `<td style="padding:8px 6px;font-size:14px;color:${TEXT};border:1px solid #ddd;text-align:center;background:#fff;line-height:1.7;">${esc(c)}</td>`)
        .join("")}</tr>`;
    })
    .join("");

  return `<p style="margin:0 0 6px 0;font-size:14px;font-weight:bold;color:${TEXT};">${esc(caption)}</p>` +
    `<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 14px 0;">` +
      `<tr>${headerCells}</tr>` +
      rowsHtml +
    `</table>`;
}

function renderJcrPartitionSection(journal: JournalInfo): string {
  const blocks: string[] = [];

  // 新锐分区表（基于 casPartitionNew，缺失则用 partition）
  const newAdvancedRows: Array<{ majorCategory: string; subCategory: string; isTop: boolean; isReview: boolean }> = [];
  if (journal.casPartitionNew || journal.partition) {
    newAdvancedRows.push({
      majorCategory: journal.discipline || "—",
      subCategory: journal.casPartitionNew || journal.partition || "—",
      isTop: !!(journal.casPartitionNew && /top/i.test(journal.casPartitionNew)),
      isReview: false,
    });
  }
  if (newAdvancedRows.length > 0) {
    blocks.push(renderPartitionTable("中科院分区（新锐版）", newAdvancedRows));
  }

  // 期刊分区表（基于 casPartition）
  const standardRows: Array<{ majorCategory: string; subCategory: string; isTop: boolean; isReview: boolean }> = [];
  if (journal.casPartition) {
    standardRows.push({
      majorCategory: journal.discipline || "—",
      subCategory: journal.casPartition,
      isTop: false,
      isReview: false,
    });
  }
  if (standardRows.length > 0) {
    blocks.push(renderPartitionTable("中科院分区", standardRows));
  }

  // WOS 分区（jcrSubjects 列表）
  const jcr = tryParseJcrSubjects(journal.jcrSubjects);
  if (jcr.length > 0) {
    const items = jcr
      .map((s) => `<p style="margin:0 0 4px 0;font-size:14px;line-height:1.7;color:${TEXT};">· ${esc(s.subject)} <strong>${esc(s.rank)}</strong>${s.position ? `（${esc(s.position)}）` : ""}</p>`)
      .join("");
    blocks.push(
      `<p style="margin:0 0 6px 0;font-size:14px;font-weight:bold;color:${TEXT};">WOS 分区</p>` +
      `<section style="margin:0 0 14px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">${items}</section>`
    );
  }

  if (blocks.length === 0) {
    blocks.push(`<p style="margin:0;font-size:14px;color:${MUTED};line-height:1.7;text-align:center;">分区数据采集中</p>`);
  }

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 12px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">JCR分区</p>` +
    blocks.join("") +
    `</section>`;
}

// ============ 区块 10: 「发文情况」蓝色居中标题 ============
function renderPubStatsHeading(): string {
  return `<section style="margin:0 0 12px 0;text-align:center;">` +
    `<p style="margin:0;font-size:18px;font-weight:bold;color:${BLUE};line-height:1.5;">发文情况</p>` +
    `</section>`;
}

// ============ 区块 11: 发文统计文字段 ============
function renderPubStatsBody(journal: JournalInfo): string {
  const journalName = esc(journal.nameEn || journal.name);
  const frequency = journal.frequency ? esc(journal.frequency) : "—";
  const annualVol = journal.annualVolume != null ? `${journal.annualVolume} 篇` : "—";

  let topInstText = "国内近三年投稿活跃机构（数据采集中）";
  if (journal.topInstitutions) {
    try {
      const arr = JSON.parse(journal.topInstitutions);
      if (Array.isArray(arr) && arr.length > 0) {
        const trimmed = arr.slice(0, 5).map((x: unknown) => esc(String(x))).join("、");
        topInstText = `国内近三年投稿活跃机构：${trimmed}`;
      }
    } catch { /* keep placeholder */ }
  }

  return `<section style="margin:0 0 22px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:14px;line-height:1.7;color:${TEXT};">` +
      `《${journalName}》为 <strong>${frequency}</strong>，2024 年文章数为 <strong>${esc(annualVol)}</strong>。` +
    `</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.7;color:${TEXT};">${topInstText}</p>` +
    `</section>`;
}

// ============ 区块 12: 「近10年的发文量」红色标题 + 柱状图占位 ============
function renderPubVolumeChartPlaceholder(): string {
  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:16px;font-weight:bold;color:${RED};text-align:center;line-height:1.5;">近10年的发文量</p>` +
    `<div style="border:1px dashed #ccc;padding:30px 16px;text-align:center;color:${MUTED};font-size:14px;line-height:1.7;border-radius:6px;background:#FCFCFC;">` +
      `📊 近 10 年发文量走势图（数据采集中）` +
    `</div>` +
    `</section>`;
}

// ============ 区块 13: 底部 CTA ============
function deriveAudienceHint(journal: JournalInfo): string {
  if (journal.casPartition === "1" || journal.partition === "Q1") {
    return "追求高影响力、评职称需高分文章的科研工作者";
  }
  if (journal.casPartition === "3" || journal.partition === "Q3" || journal.partition === "Q2") {
    return "即将毕业、需要稳妥发表的硕博生";
  }
  if (journal.acceptanceRate && journal.acceptanceRate >= 0.4) {
    return "初次投 SCI 想累积成功经验的青年作者";
  }
  if (journal.discipline) {
    return `专注 ${journal.discipline} 方向的研究者`;
  }
  return "目标投稿人";
}

function renderCTA(journal: JournalInfo, aiContent: AIGeneratedContent): string {
  const journalName = esc(journal.nameEn || journal.name);
  const audienceHint = esc(deriveAudienceHint(journal));
  const recoSummary = aiContent.recommendation
    ? esc(aiContent.recommendation.replace(/\s+/g, " ").slice(0, 120))
    : "";

  return `<section style="margin:0 0 16px 0;padding:16px 18px;background:#F5F5F5;border-radius:8px;text-align:center;">` +
    `<p style="margin:0 0 8px 0;font-size:15px;font-weight:600;color:${TEXT};line-height:1.7;">综合来看</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.8;color:#555;">` +
      `<strong style="color:${RED};">${journalName}</strong> 适合：${audienceHint}` +
    `</p>` +
    (recoSummary ? `<p style="margin:8px 0 0 0;font-size:13px;line-height:1.7;color:#666;">${recoSummary}</p>` : "") +
    `</section>`;
}

// ============ 主入口 ============

export async function generateShunshiStyleHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  _abstracts?: Abstracts
): Promise<string> {
  const sections: string[] = [];

  // 区块 1（顶部钩子标题）由 article-skill 的 title 承载，body 不渲染。
  sections.push(renderTopRecommendBanner());          // 2
  sections.push(renderJournalNameRed(journal));       // 3
  sections.push(renderAbbreviation(journal));         // 4 (可选)
  sections.push(renderBasicInfo(journal));            // 5
  sections.push(renderCoverImage(journal));           // 6 (可选)
  sections.push(renderIfChartPlaceholder(journal));   // 7
  sections.push(renderCarIndexPlaceholder(journal));  // 8
  sections.push(renderJcrPartitionSection(journal));  // 9
  sections.push(renderPubStatsHeading());             // 10
  sections.push(renderPubStatsBody(journal));         // 11
  sections.push(renderPubVolumeChartPlaceholder());   // 12
  sections.push(renderCTA(journal, aiContent));       // 13

  return sections.filter((s) => s.length > 0).join("\n");
}
