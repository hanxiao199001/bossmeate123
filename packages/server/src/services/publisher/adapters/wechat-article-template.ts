/**
 * 微信公众号专用期刊推荐模板 V12 —— section 布局版
 *
 * 微信 CSS 能力（实测）：
 * ✅ border-radius、box-shadow、background-color、opacity、display:inline-block、
 *    text-align、vertical-align、line-height、letter-spacing、margin、padding、
 *    border、color、font-size、font-weight、width(px)、height(px)、linear-gradient
 * ❌ flex、position、transform、@media、@keyframes、class、id、<style>、font-family
 *
 * 布局：<section> + inline style（只在数据表格处用 <table>）
 * emoji：直接 Unicode 字符，不用 HTML entity
 * 分隔符：直接 · 不用 &middot;
 */

import type { JournalInfo, CollectionResult } from "../../data-collection/journal-content-collector.js";
import { getJournalCover, type CoverResult } from "../../crawler/cover-fetcher.js";
import {
  type ThemeColors, type AIGeneratedContent, type NarrativeStyle, type SellingPoint,
  THEMES, WECHAT_QR_BASE64,
  resolveTheme, chooseNarrative, analyzeSellingPoints, inferIndexBadges,
  esc, getIfColor, getPartitionColor,
} from "../../skills/journal-template.js";
import { generateIFTrendChart, generatePubVolumeChart, svgToDataUri } from "../../crawler/journal-chart-generator.js";

// ============ 主题深色映射 ============

const THEME_DARKER: Record<string, string> = {
  "#c41e3a": "#8B0000",   // medical
  "#1d4ed8": "#1e3a8a",   // engineering
  "#15803d": "#1B5E20",   // social
  "#7c3aed": "#4c1d95",   // science
  "#0e7490": "#064e3b",   // biology
};

function getDarkerShade(theme: ThemeColors): string {
  return THEME_DARKER[theme.primary] || theme.sideBar;
}

// ============ 通用组件 ============

export function sectionTitle(title: string, emoji: string, theme: ThemeColors): string {
  return `<section style="margin:20px 0 8px 0;padding:0 0 8px 0;border-bottom:2px solid ${theme.primary};">` +
    `<p style="margin:0;font-size:17px;font-weight:bold;color:#333;">${emoji} ${esc(title)}</p>` +
    `</section>`;
}

// ============ 区块 1: 免责声明 ============

export function renderDisclaimer(): string {
  return `<section style="margin:12px 0;padding:10px 14px;background:#FFF8E1;border-left:4px solid #FFB300;border-radius:4px;font-size:13px;color:#795548;line-height:1.6;">` +
    `⚠️ 以下期刊信息由 AI 智能推荐生成，<strong>仅供参考</strong>。具体数据请以官方来源（知网、LetPub、JCR 等）为准，投稿前务必自行核实。` +
    `</section>`;
}

// ============ 区块 2: 封面大图 ============

/**
 * 封面图渲染：
 * - HD（316×419px+）：居中大图 max-width:100%
 * - 非 HD（100px 缩略图）：居中小图 max-width:150px + 圆角阴影，不拉大不模糊
 * - 无封面：不渲染
 */
export function renderCoverHero(cover: CoverResult): string {
  if (!cover.url) return "";

  if (cover.isHd) {
    return `<section style="margin:12px 0;text-align:center;">` +
      `<img src="${esc(cover.url)}" style="max-width:100%;width:auto;height:auto;border-radius:8px;display:block;margin:0 auto;" />` +
      `</section>`;
  }

  // 非 HD 小图：150px 宽（原图 100px 放大 1.5 倍可接受），圆角阴影让小图像卡片
  return `<section style="margin:12px 0;text-align:center;">` +
    `<img src="${esc(cover.url)}" style="max-width:150px;height:auto;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.1);display:block;margin:0 auto;" />` +
    `</section>`;
}

// ============ 区块 3: 期刊名称卡片（渐变背景） ============

/**
 * 期刊名称卡片。cover 参数控制小图展示：
 * - cover.isHd=false 且有 URL：在卡片内左侧展示 100px 小图
 * - cover.isHd=true：小图不在此展示（由独立 renderCoverHero 负责）
 */
export function renderJournalCard(journal: JournalInfo, theme: ThemeColors): string {
  const displayName = journal.nameEn || journal.name;
  const darker = getDarkerShade(theme);

  // meta line: 简称 · 出版商 · 国家
  const metaParts: string[] = [];
  if (journal.abbreviation) metaParts.push(esc(journal.abbreviation));
  if (journal.organizerName) metaParts.push(esc(journal.organizerName));
  else if (journal.publisher) metaParts.push(esc(journal.publisher));
  if (journal.country) metaParts.push(esc(journal.country));
  const metaLine = metaParts.join(" · ");

  return `<section style="margin:12px 0;padding:20px;background:${theme.primary};background:linear-gradient(135deg,${darker},${theme.primary});border-radius:12px;color:#fff;">` +
    `<p style="margin:0 0 4px 0;font-size:12px;letter-spacing:2px;color:rgba(255,255,255,0.7);">JOURNAL RECOMMENDATION</p>` +
    `<p style="margin:0 0 4px 0;font-size:22px;font-weight:bold;">${esc(displayName)}</p>` +
    (metaLine ? `<p style="margin:0;font-size:13px;color:rgba(255,255,255,0.8);">${metaLine}</p>` : "") +
    (journal.issn ? `<p style="margin:8px 0 0 0;font-size:13px;color:rgba(255,255,255,0.8);">ISSN: ${esc(journal.issn)}</p>` : "") +
    `</section>`;
}

// ============ 区块 4: 四宫格 ============

export function renderCoreStats(journal: JournalInfo, theme: ThemeColors): string {
  const cells: Array<{
    value: string;
    label: string;
    bg: string;
    color: string;
    bigFont: boolean;
  }> = [];

  // IF
  if (journal.impactFactor != null) {
    cells.push({
      value: journal.impactFactor.toFixed(1),
      label: "影响因子",
      bg: "#E3F2FD",
      color: "#1565C0",
      bigFont: true,
    });
  } else if (journal.compositeIF != null) {
    cells.push({
      value: journal.compositeIF.toFixed(3),
      label: "影响因子",
      bg: "#E3F2FD",
      color: "#1565C0",
      bigFont: true,
    });
  }

  // 分区（去重 TOP：casPartition 可能已含 "TOP"，不再重复追加）
  const partition = journal.casPartition || journal.partition;
  if (partition) {
    const alreadyHasTop = /TOP/i.test(partition);
    const isTop = !alreadyHasTop && journal.casPartitionNew?.toUpperCase().includes("TOP");
    const partitionDisplay = `${esc(partition)}${isTop ? " TOP" : ""}`.replace(/(TOP)\s*\1+/gi, "$1");
    cells.push({
      value: partitionDisplay,
      label: "中科院分区",
      bg: "#FFF3E0",
      color: "#E65100",
      bigFont: false,
    });
  } else if (journal.coreLevel) {
    cells.push({
      value: esc(journal.coreLevel),
      label: "中科院分区",
      bg: "#FFF3E0",
      color: "#E65100",
      bigFont: false,
    });
  }

  // 录用率
  if (journal.acceptanceRate != null) {
    const ratePercent = journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100;
    cells.push({
      value: `${ratePercent.toFixed(0)}%`,
      label: "录用率",
      bg: "#E8F5E9",
      color: "#2E7D32",
      bigFont: true,
    });
  }

  // 审稿周期
  if (journal.reviewCycle) {
    cells.push({
      value: esc(journal.reviewCycle),
      label: "审稿周期",
      bg: "#F3E5F5",
      color: "#6A1B9A",
      bigFont: false,
    });
  }

  if (cells.length === 0) return "";

  function cellTd(c: typeof cells[0]): string {
    const fontSize = c.bigFont ? "24" : "16";
    return `<td style="width:50%;padding:16px 8px;background:${c.bg};border-radius:8px;text-align:center;">` +
      `<p style="margin:0;font-size:${fontSize}px;font-weight:bold;color:${c.color};">${c.value}</p>` +
      `<p style="margin:4px 0 0 0;font-size:12px;color:#666;">${c.label}</p>` +
      `</td>`;
  }

  let rows = "";
  if (cells.length <= 2) {
    rows = `<tr>${cells.map(c => cellTd(c)).join("")}</tr>`;
  } else {
    rows = `<tr>${cellTd(cells[0])}${cellTd(cells[1])}</tr>`;
    if (cells.length >= 3) {
      rows += `<tr>${cellTd(cells[2])}${cells[3] ? cellTd(cells[3]) : `<td style="width:50%;"></td>`}</tr>`;
    }
  }

  return `<section style="margin:16px 0;">` +
    `<p style="text-align:center;font-size:17px;font-weight:bold;color:${theme.primary};margin:0 0 12px 0;">核心数据一览</p>` +
    `<table style="width:100%;border-collapse:separate;border-spacing:8px;" cellpadding="0" cellspacing="0">` +
    rows +
    `</table>` +
    `</section>`;
}

// ============ 区块 5: 小编说 ============

export function renderEditorComment(comment: string, theme: ThemeColors): string {
  return `<section style="margin:16px 0;padding:14px 16px;background:#F5F5F5;border-left:4px solid ${theme.primary};border-radius:0 8px 8px 0;">` +
    `<p style="margin:0 0 6px 0;font-size:13px;font-weight:bold;color:${theme.primary};">💬 小编说</p>` +
    `<p style="margin:0;font-size:14px;color:#555;line-height:1.7;">${esc(comment)}</p>` +
    `</section>`;
}

// ============ 区块 6: 开场钩子 ============

export function renderOpeningHook(
  journal: JournalInfo,
  _aiContent: AIGeneratedContent,
  sellingPoints: SellingPoint[],
  narrative: NarrativeStyle,
  theme: ThemeColors,
): string {
  const top3 = sellingPoints.slice(0, 3).map(p => p.headline);

  if (narrative === "qa") {
    const questions: string[] = [];
    if (journal.acceptanceRate != null) questions.push("好投吗？录用率如何？");
    if (journal.reviewCycle) questions.push("审稿快不快？多久出结果？");
    if (journal.impactFactor != null) questions.push("影响因子高不高？值得投吗？");
    if (journal.apcFee != null) questions.push("版面费贵不贵？");
    const topQ = questions.slice(0, 3);

    return `<section style="margin:16px 0;padding:18px;background:${theme.primaryBg};border:1px solid ${theme.primaryBorder};border-radius:12px;">` +
      `<p style="margin:0 0 10px 0;font-size:13px;color:${theme.accent};font-weight:bold;letter-spacing:2px;">❓ 投稿前你最想知道</p>` +
      topQ.map((q, i) =>
        `<p style="margin:0 0 4px 0;font-size:15px;color:#555;">` +
        `<span style="display:inline-block;width:22px;height:22px;background:${theme.accent};color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:12px;margin-right:8px;">${i + 1}</span>` +
        `${esc(q)}</p>`
      ).join("") +
      `<p style="margin:10px 0 0 0;font-size:13px;color:#999;">👇 带着这些问题往下看，一篇文章帮你全搞清楚</p>` +
      `</section>`;
  }

  if (narrative === "story") {
    const first = journal.ifHistory?.[0];
    const last = journal.ifHistory?.[journal.ifHistory.length - 1];
    const storyText = first && last
      ? `从 ${first.year} 年的 IF ${first.value.toFixed(1)}，到 ${last.year} 年的 ${last.value.toFixed(1)}，《${esc(journal.nameEn || journal.name)}》用 ${last.year - first.year} 年完成了一场惊人的蜕变。`
      : `《${esc(journal.nameEn || journal.name)}》近年来表现亮眼。`;

    const tagsHtml = top3.length > 0
      ? `<p style="margin:12px 0 0 0;">` +
        top3.map(t =>
          `<span style="display:inline-block;padding:4px 12px;margin:3px;background:${theme.primaryLight};color:${theme.primary};border-radius:20px;font-size:12px;font-weight:600;">${esc(t)}</span>`
        ).join("") +
        `</p>`
      : "";

    return `<section style="margin:16px 0;padding:18px;background:${theme.primaryBg};border:1px solid ${theme.primaryBorder};border-radius:12px;">` +
      `<p style="margin:0 0 8px 0;font-size:13px;color:${theme.accent};font-weight:bold;letter-spacing:2px;">📖 期刊崛起史</p>` +
      `<p style="margin:0;font-size:16px;line-height:1.8;color:#333;">${storyText}</p>` +
      tagsHtml +
      `</section>`;
  }

  if (narrative === "review") {
    const reviewTagsHtml = top3.map(t =>
      `<span style="display:inline-block;padding:6px 14px;margin:3px;background:#fff;border:1px solid ${theme.primaryBorder};color:${theme.primary};border-radius:20px;font-size:13px;font-weight:600;">${esc(t)}</span>`
    ).join("");

    return `<section style="margin:16px 0;padding:18px;background:${theme.primaryBg};border:1px solid ${theme.primaryBorder};border-radius:12px;">` +
      `<p style="margin:0 0 10px 0;font-size:13px;color:${theme.accent};font-weight:bold;letter-spacing:2px;">🔍 一分钟速览</p>` +
      `<p style="margin:0;">${reviewTagsHtml}</p>` +
      `</section>`;
  }

  // ranking
  const scoreCardHtml = renderMiniScoreCard(journal, theme);
  return `<section style="margin:16px 0;padding:18px;background:${theme.primaryBg};border:1px solid ${theme.primaryBorder};border-radius:12px;">` +
    `<p style="margin:0 0 12px 0;font-size:13px;color:${theme.accent};font-weight:bold;letter-spacing:2px;">📊 期刊综合评分卡</p>` +
    scoreCardHtml +
    `</section>`;
}

/** 迷你评分卡（盘点体专用） — 用 table 模拟进度条 */
function renderMiniScoreCard(j: JournalInfo, theme: ThemeColors): string {
  const metrics: Array<{ label: string; score: number; display: string }> = [];

  if (j.impactFactor != null) {
    const s = Math.min(100, j.impactFactor * 5);
    metrics.push({ label: "影响因子", score: s, display: j.impactFactor.toFixed(1) });
  }
  if (j.casPartition?.includes("1区") || j.partition?.includes("Q1")) {
    metrics.push({ label: "分区等级", score: 95, display: j.casPartition || j.partition || "" });
  } else if (j.partition) {
    metrics.push({ label: "分区等级", score: 60, display: j.partition });
  }
  if (j.acceptanceRate != null) {
    const rate = j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100;
    metrics.push({ label: "录用难度", score: Math.max(10, 100 - rate * 2), display: `${rate.toFixed(0)}%` });
  }
  if (j.reviewCycle) {
    const match = j.reviewCycle.match(/(\d+)/);
    const days = match ? parseInt(match[1]) : 60;
    const s = Math.max(10, Math.min(100, (120 - days) / 120 * 100));
    metrics.push({ label: "审稿速度", score: s, display: j.reviewCycle });
  }

  if (metrics.length === 0) return "";

  return metrics.map(m => {
    const barWidth = Math.round(m.score);
    return `<table style="width:100%;border-collapse:collapse;margin-bottom:10px;" cellpadding="0" cellspacing="0">` +
      `<tr>` +
      `<td style="font-size:13px;color:#666;padding:0 0 4px 0;">${esc(m.label)}</td>` +
      `<td style="font-size:13px;color:${theme.primary};font-weight:bold;padding:0 0 4px 0;text-align:right;">${esc(m.display)}</td>` +
      `</tr>` +
      `<tr><td colspan="2" style="padding:0;">` +
      `<table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tr>` +
      `<td style="height:8px;background:#e5e7eb;border-radius:4px;">` +
      `<table cellpadding="0" cellspacing="0" width="${barWidth}%"><tr>` +
      `<td style="height:8px;background:${theme.accent};border-radius:4px;"></td>` +
      `</tr></table></td></tr></table>` +
      `</td></tr></table>`;
  }).join("");
}

// ============ 区块 7: 影响因子与分区概述 ============

export function renderIFOverview(journal: JournalInfo, aiContent: AIGeneratedContent, theme: ThemeColors): string {
  const isDomestic = !!(journal.catalogs?.length || journal.cnNumber || journal.compositeIF);
  let content = `《${esc(journal.nameEn || journal.name)}》`;

  // IF description
  if (journal.impactFactor != null) {
    const ifText = journal.impactFactor.toFixed(1);
    content += `最新影响因子为 <strong style="color:${theme.primary};font-size:18px;font-weight:bold;">${ifText}</strong> 分`;
    if (aiContent.ifPrediction) content += `（${esc(aiContent.ifPrediction)}）`;
    content += `！`;
  } else if (journal.compositeIF != null) {
    content += `复合影响因子为 <strong style="color:${theme.primary};font-size:18px;font-weight:bold;">${journal.compositeIF.toFixed(3)}</strong>`;
    if (journal.comprehensiveIF != null) content += `，综合影响因子 <strong>${journal.comprehensiveIF.toFixed(3)}</strong>`;
    content += `（知网数据）。`;
  } else if (journal.comprehensiveIF != null) {
    content += `综合影响因子为 <strong style="color:${theme.primary};font-size:18px;font-weight:bold;">${journal.comprehensiveIF.toFixed(3)}</strong>（知网数据）。`;
  }

  // partition / core level
  if (journal.casPartition) {
    content += `中科院分区 <strong>${esc(journal.casPartition)}</strong>`;
    if (journal.casPartitionNew) content += `（新锐分区 <strong>${esc(journal.casPartitionNew)}</strong>）`;
    content += `。`;
  } else if (journal.partition) {
    content += `JCR 分区 <strong style="color:${getPartitionColor(journal.partition)};">${esc(journal.partition)}</strong>。`;
  } else if (journal.coreLevel) {
    content += `属于 <strong style="color:#991b1b;">${esc(journal.coreLevel)}</strong> 期刊`;
    const cats = journal.catalogs || [];
    if (cats.length > 0) {
      const catLabels = cats.map(c => {
        const map: Record<string, string> = { "pku-core": "北大核心", cssci: "CSSCI", cscd: "CSCD", cstpcd: "科技核心", ami: "AMI" };
        return map[c] || c;
      });
      content += `，被 ${catLabels.join("、")} 收录`;
    }
    content += `。`;
  }

  // discipline positioning
  if (journal.discipline) {
    content += `是${esc(journal.discipline)}领域的`;
    if (isDomestic) {
      if (journal.coreLevel?.includes("北大核心") || journal.catalogs?.includes("cssci")) content += `国内权威核心期刊`;
      else if (journal.catalogs?.length) content += `国内核心期刊`;
      else content += `重要学术期刊`;
    } else {
      if (journal.impactFactor && journal.impactFactor >= 10) content += `国际权威期刊`;
      else if (journal.impactFactor && journal.impactFactor >= 5) content += `高水平期刊`;
      else content += `重要学术期刊`;
    }
  }

  if (journal.organizerName && isDomestic) {
    content += `，由${esc(journal.organizerName)}主办`;
    if (journal.supervisorName) content += `，${esc(journal.supervisorName)}主管`;
    content += `。`;
  } else if (journal.publisher) {
    content += `，由 ${esc(journal.publisher)} 出版。`;
  }

  const sTitle = isDomestic ? "期刊概况与核心收录" : "影响因子与分区";

  return sectionTitle(sTitle, "📊", theme) +
    `<section style="margin:8px 0;padding:12px 16px;background:#FAFAFA;border-left:4px solid ${theme.accent};border-radius:0 8px 8px 0;">` +
    `<p style="margin:0;font-size:15px;line-height:1.8;">${content}</p>` +
    `</section>`;
}

// ============ 区块 8: IF 趋势图 ============

export function renderIFTrendChart(journal: JournalInfo): string {
  if (!journal.ifHistory || journal.ifHistory.length < 3) return "";

  const chartSvg = generateIFTrendChart(journal.ifHistory);
  if (!chartSvg) return "";

  const chartUri = svgToDataUri(chartSvg);

  return `<section style="margin:16px 0;text-align:center;">` +
    `<img src="${chartUri}" alt="${esc(journal.name)} 影响因子趋势" style="width:100%;height:auto;border-radius:8px;" />` +
    `</section>`;
}

// ============ 区块 9: 分区详情 ============

export function renderPartitionDetail(journal: JournalInfo, theme: ThemeColors): string {
  const hasJcr = journal.letpubJcrPartitions && journal.letpubJcrPartitions.length > 0;
  const hasCas = journal.letpubCasPartitions && journal.letpubCasPartitions.length > 0;

  if (!hasJcr && !hasCas) {
    // Fallback: simple text
    const items: string[] = [];

    if (journal.partition) {
      items.push(`<strong>JCR 分区：</strong><span style="color:${getPartitionColor(journal.partition)};font-weight:bold;">${esc(journal.partition)}</span>`);
    }

    if (journal.jcrSubjects) {
      try {
        const subjects = JSON.parse(journal.jcrSubjects) as Array<{ subject: string; rank: string; position?: string }>;
        for (const s of subjects) {
          const posText = s.position ? `（${s.position}）` : "";
          items.push(`${esc(s.subject)}：<strong style="color:${getPartitionColor(s.rank)};">${esc(s.rank)}</strong>${posText}`);
        }
      } catch { /* skip */ }
    }

    if (journal.casPartition) {
      items.push(`<strong>中科院分区：</strong>${esc(journal.casPartition)}`);
    }
    if (journal.casPartitionNew) {
      items.push(`<strong>新锐分区：</strong>${esc(journal.casPartitionNew)}`);
    }

    if (items.length === 0) return "";

    return sectionTitle("期刊分区", "📋", theme) +
      `<section style="margin:12px 0;padding:12px 16px;background:#FAFAFA;border-radius:8px;">` +
      items.map(item => `<p style="margin:0 0 4px 0;font-size:14px;line-height:1.8;">${item}</p>`).join("") +
      `</section>`;
  }

  let html = sectionTitle("期刊分区", "📋", theme);

  // JCR 分区列表
  if (hasJcr) {
    const jcrZone = journal.letpubJcrPartitions![0]?.zone || "";
    html += `<section style="margin:12px 0;padding:12px 16px;background:#FAFAFA;border-radius:8px;">` +
      `<p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:#333;">JCR 分区：<span style="color:${theme.primary};">${esc(jcrZone)}</span></p>`;
    for (const p of journal.letpubJcrPartitions!) {
      html += `<p style="margin:0 0 4px 0;font-size:13px;color:#555;">· ${esc(p.subject)} ${esc(p.zone)} ${esc(p.rank)}</p>`;
    }
    html += `</section>`;
  }

  // CAS 分区列表
  if (hasCas) {
    html += `<section style="margin:12px 0;padding:12px 16px;background:#FAFAFA;border-radius:8px;">` +
      `<p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:#333;">中科院分区</p>`;
    for (const p of journal.letpubCasPartitions!) {
      html += `<p style="margin:0 0 4px 0;font-size:13px;color:#555;font-weight:bold;">${esc(p.version)}${p.publishDate ? ` (${esc(p.publishDate)})` : ""} — 大类：${esc(p.majorCategory)}${p.isTop ? " · TOP期刊" : ""}${p.isReview ? " · 综述期刊" : ""}</p>`;
      for (const sub of p.subCategories) {
        html += `<p style="margin:0 0 4px 0;font-size:13px;color:#555;">· ${esc(sub.subject)} ${esc(sub.zone)}</p>`;
      }
    }
    html += `</section>`;
  }

  // JCI 分区列表
  if (journal.letpubJciPartitions && journal.letpubJciPartitions.length > 0) {
    html += `<section style="margin:12px 0;padding:12px 16px;background:#FAFAFA;border-radius:8px;">` +
      `<p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:#333;">JCI 分区</p>`;
    for (const p of journal.letpubJciPartitions) {
      html += `<p style="margin:0 0 4px 0;font-size:13px;color:#555;">· ${esc(p.subject)} ${esc(p.zone)} ${esc(p.rank)}</p>`;
    }
    html += `</section>`;
  }

  return html;
}

// ============ 区块 10: 划重点 ============

export function renderHighlightBox(tip: string, theme: ThemeColors): string {
  return `<section style="margin:12px 0;padding:12px 16px;background:#FFF8E1;border:1px dashed #FFB300;border-radius:8px;">` +
    `<p style="margin:0;font-size:14px;color:${theme.primary};font-weight:bold;">📌 划重点：${esc(tip)}</p>` +
    `</section>`;
}

// ============ 区块 11: 审稿周期 ============

export function renderReviewCycle(journal: JournalInfo, theme: ThemeColors): string {
  if (!journal.reviewCycle) return "";

  const content = `《${esc(journal.nameEn || journal.name)}》审稿周期：<strong style="color:${theme.accent};">${esc(journal.reviewCycle)}</strong>。`;

  return sectionTitle("审稿周期", "⏱", theme) +
    `<section style="margin:8px 0;padding:12px 16px;background:#FAFAFA;border-left:4px solid ${theme.accent};border-radius:0 8px 8px 0;">` +
    `<p style="margin:0;font-size:15px;line-height:1.8;">${content}</p>` +
    `</section>`;
}

// ============ 区块 12: 发文情况 ============

export function renderPublicationStats(journal: JournalInfo, theme: ThemeColors): string {
  const parts: string[] = [];
  parts.push(`《${esc(journal.nameEn || journal.name)}》`);

  if (journal.annualVolume) {
    parts.push(`近年年发文量约 <strong>${journal.annualVolume}</strong> 篇`);
  }

  if (journal.acceptanceRate != null) {
    const ratePercent = journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100;
    parts.push(`整体录用率约为 <strong>${ratePercent.toFixed(0)}%</strong>`);
  }

  let institutionsHtml = "";
  if (journal.topInstitutions) {
    try {
      const institutions = JSON.parse(journal.topInstitutions) as string[];
      if (institutions.length > 0) {
        institutionsHtml = `<p style="margin:8px 0 0 0;font-size:14px;color:#555;">国内投稿活跃机构：${institutions.map(i => esc(i)).join("、")}等。</p>`;
      }
    } catch { /* skip */ }
  }

  return sectionTitle("发文情况", "📊", theme) +
    `<section style="margin:8px 0;padding:12px 16px;background:#FAFAFA;border-left:4px solid ${theme.accent};border-radius:0 8px 8px 0;">` +
    `<p style="margin:0;font-size:15px;line-height:1.8;">${parts.join("，")}。</p>` +
    institutionsHtml +
    `</section>`;
}

// ============ 发文量趋势图 ============

export function renderPubVolumeChart(journal: JournalInfo): string {
  if (!journal.pubVolumeHistory || journal.pubVolumeHistory.length < 3) return "";

  const chartSvg = generatePubVolumeChart(journal.pubVolumeHistory);
  if (!chartSvg) return "";

  const chartUri = svgToDataUri(chartSvg);

  return `<section style="margin:16px 0;text-align:center;">` +
    `<img src="${chartUri}" alt="${esc(journal.name)} 发文量趋势" style="width:100%;height:auto;border-radius:8px;" />` +
    `</section>`;
}

// ============ 收稿范围 ============

export function renderScope(_journal: JournalInfo, scopeDescription: string, theme: ThemeColors): string {
  return sectionTitle("收稿范围", "📋", theme) +
    `<section style="margin:8px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:15px;line-height:1.8;color:#333;">${scopeDescription}</p>` +
    `</section>`;
}

// ============ 版面费 ============

export function renderAPC(journal: JournalInfo, theme: ThemeColors, isHighlight: boolean): string {
  if (isHighlight) {
    return sectionTitle("版面费", "📋", theme) +
      `<section style="margin:8px 0;padding:12px 16px;background:#FAFAFA;border-left:4px solid ${theme.accent};border-radius:0 8px 8px 0;">` +
      `<p style="margin:0;font-size:24px;font-weight:bold;color:${theme.accent};text-align:center;">FREE</p>` +
      `<p style="margin:4px 0 0 0;font-size:15px;color:#555;text-align:center;">本刊无需版面费，零成本发表！OA 期刊，全球开放获取。</p>` +
      `</section>`;
  }

  if (!journal.apcFee) return "";

  const cnyEstimate = Math.round(journal.apcFee * 7.2);

  return sectionTitle("版面费", "📋", theme) +
    `<section style="margin:8px 0;padding:12px 16px;background:#FAFAFA;border-left:4px solid ${theme.accent};border-radius:0 8px 8px 0;">` +
    `<p style="margin:0;font-size:15px;line-height:1.8;">《${esc(journal.nameEn || journal.name)}》需支付版面费 <strong>$${journal.apcFee.toLocaleString()}</strong>（约合人民币 <strong>${cnyEstimate.toLocaleString()}</strong> 元）。作为开放获取期刊，读者可免费访问所有文章，有利于研究成果的广泛传播和引用。</p>` +
    `</section>`;
}

// ============ 自引率 ============

export function renderSelfCitation(journal: JournalInfo, theme: ThemeColors): string {
  if (journal.selfCitationRate == null) return "";

  const rate = journal.selfCitationRate;
  const safe = rate < 20;

  return sectionTitle("自引率", "📊", theme) +
    `<section style="margin:8px 0;padding:12px 16px;background:#FAFAFA;border-left:4px solid ${theme.accent};border-radius:0 8px 8px 0;">` +
    `<p style="margin:0;font-size:15px;line-height:1.8;">${esc(journal.nameEn || journal.name)} 自引率为 <strong>${rate.toFixed(1)}%</strong>，${safe ? `处于安全范围，可放心投稿。` : `偏高，投稿时需关注。`}</p>` +
    `</section>`;
}

// ============ 预警名单 ============

export function renderWarning(journal: JournalInfo, theme: ThemeColors): string {
  if (journal.isWarningList) {
    return sectionTitle("预警名单", "⚠️", theme) +
      `<section style="margin:8px 0;padding:12px 16px;background:#FFF8E1;border-left:4px solid #FFB300;border-radius:0 8px 8px 0;">` +
      `<p style="margin:0;color:#dc2626;font-weight:bold;font-size:15px;">⚠️ 该期刊在中科院《国际期刊预警名单》中${journal.warningYear ? `（${esc(journal.warningYear)} 版）` : ""}，投稿需谨慎评估。</p>` +
      `</section>`;
  }

  return sectionTitle("预警名单", "✅", theme) +
    `<section style="margin:8px 0;padding:12px 16px;background:#E8F5E9;border-left:4px solid #2E7D32;border-radius:0 8px 8px 0;">` +
    `<p style="margin:0;color:#16a34a;font-size:15px;">✅ 中科院《国际期刊预警名单》：<strong>不在预警名单中</strong>，可放心投稿。</p>` +
    `</section>`;
}

// ============ 区块 13: 基本信息表 ============

/**
 * 基本信息 —— 上下堆叠卡片式（不用 table 两列，手机上永远不会折行竖排）
 */
export function renderBasicInfoTable(journal: JournalInfo): string {
  const displayName = journal.nameEn || journal.name;
  const items: Array<{ label: string; value: string }> = [];

  items.push({ label: "全称", value: esc(displayName) });
  if (journal.nameEn && journal.name !== journal.nameEn) items.push({ label: "中文名", value: esc(journal.name) });
  if (journal.abbreviation) items.push({ label: "简称", value: esc(journal.abbreviation) });
  if (journal.foundingYear) items.push({ label: "创刊", value: `${journal.foundingYear}年` });
  if (journal.country) items.push({ label: "国家", value: esc(journal.country) });
  if (journal.publisher) items.push({ label: "出版商", value: esc(journal.publisher) });
  if (journal.organizerName) items.push({ label: "主办", value: esc(journal.organizerName) });
  if (journal.supervisorName) items.push({ label: "主管", value: esc(journal.supervisorName) });
  if (journal.issn) items.push({ label: "ISSN", value: esc(journal.issn) });
  if (journal.cnNumber) items.push({ label: "CN 刊号", value: esc(journal.cnNumber) });
  if (journal.frequency) items.push({ label: "刊期", value: esc(journal.frequency) });
  if (journal.website) items.push({ label: "官网", value: `<a href="${esc(journal.website)}" style="color:#4f46e5;text-decoration:underline;">${esc(journal.website)}</a>` });

  if (items.length === 0) return "";

  const theme = resolveTheme(journal.discipline);
  const itemsHtml = items.map((item) =>
    `<p style="margin:0 0 4px 0;font-size:12px;color:#999;">${item.label}</p>` +
    `<p style="margin:0 0 12px 0;font-size:15px;color:#333;">${item.value}</p>`
  ).join("");

  return sectionTitle("基本信息", "📋", theme) +
    `<section style="margin:8px 0;padding:16px;background:#FAFAFA;border-radius:8px;">` +
    itemsHtml +
    `</section>`;
}

// ============ 区块 14: 推荐指数 ============

export function renderRating(aiContent: AIGeneratedContent, theme: ThemeColors): string {
  const rating = aiContent.rating || 4;
  const fullStar = "★";
  const emptyStar = "☆";
  const stars = fullStar.repeat(rating) + emptyStar.repeat(5 - rating);

  return sectionTitle("推荐指数", "⭐", theme) +
    `<section style="margin:16px 0;padding:16px;background:#F5F5F5;border-radius:8px;">` +
    `<p style="margin:0 0 12px 0;font-size:28px;letter-spacing:6px;color:${theme.accent};text-align:center;">${stars}</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.8;color:#333;">${aiContent.recommendation || ""}</p>` +
    `</section>`;
}

// ============ 区块 15: 来源引用 ============

export function renderSourceLine(): string {
  return `<p style="margin:16px 0 8px 0;font-size:12px;color:#999;text-align:center;">以上分析仅供参考，数据来源：LetPub、Springer Nature、PubMed</p>`;
}

// ============ 区块 16: 服务名片卡 ============

export function renderServiceCard(_theme: ThemeColors): string {
  const serviceTags = ["SCI", "SSCI", "AHCI", "Scopus", "CPCI", "EI源刊", "EI会议", "英文普刊", "著作", "核心", "专利", "国内普刊"];
  const tagStyle = `display:inline-block;padding:2px 10px;margin:3px;background:rgba(255,255,255,0.15);border-radius:12px;font-size:12px;color:#fff;`;

  const tagsHtml = serviceTags.map(t =>
    `<span style="${tagStyle}">${esc(t)}</span>`
  ).join("");

  return `<section style="margin:16px 0;border-top:1px solid #eee;"></section>` +
    `<section style="margin:12px 0;padding:20px;background:#1A237E;border-radius:12px;color:#fff;">` +
    `<p style="margin:0 0 4px 0;font-size:14px;color:rgba(255,255,255,0.7);text-align:center;">一站式科研服务 · 更快录用</p>` +
    `<p style="margin:10px 0;text-align:center;line-height:2.2;">${tagsHtml}</p>` +
    `<table style="width:100%;margin:12px 0 0 0;" cellpadding="0" cellspacing="0">` +
    `<tr>` +
    `<td style="vertical-align:middle;padding-right:12px;">` +
    `<p style="margin:0;font-size:13px;color:rgba(255,255,255,0.7);">精准选刊 · 正刊投稿 · 全程指导</p>` +
    `<p style="margin:4px 0;font-size:12px;color:rgba(255,255,255,0.6);">微信咨询</p>` +
    `<p style="margin:4px 0 0 0;font-size:22px;font-weight:bold;color:#FFD54F;">Wlfj2020</p>` +
    `<p style="margin:6px 0 0 0;font-size:11px;color:rgba(255,255,255,0.5);">专业团队 · 安全可靠 · 渠道高效</p>` +
    `</td>` +
    `<td style="width:100px;vertical-align:middle;text-align:center;">` +
    `<img src="${WECHAT_QR_BASE64}" style="width:90px;height:90px;border-radius:4px;border:2px solid rgba(255,255,255,0.3);" />` +
    `<p style="margin:4px 0 0 0;font-size:11px;color:rgba(255,255,255,0.6);">扫码添加微信</p>` +
    `</td>` +
    `</tr>` +
    `</table>` +
    `</section>`;
}

// ============ 品牌底线 ============

export function renderBrandLine(): string {
  return `<p style="margin:12px 0 20px 0;text-align:center;font-size:12px;color:#999;">顺仕美途科研服务平台 · BossMate AI</p>`;
}

// ============ 主入口函数 ============

export async function generateWechatJournalArticleHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  _abstracts?: CollectionResult["abstracts"],
): Promise<string> {
  const theme = resolveTheme(journal.discipline);
  const narrative = chooseNarrative(journal);
  const sellingPoints = analyzeSellingPoints(journal);
  const sections: string[] = [];

  // 获取封面（HD 优先，fallback LetPub）
  let cover: CoverResult;
  try {
    cover = await getJournalCover(journal as any);
  } catch {
    cover = { url: journal.coverUrl || "", isHd: false };
  }

  // 区块 1: 免责
  if (journal.synthetic) sections.push(renderDisclaimer());

  // 区块 2: 封面图（小尺寸展示，不拉大）
  // 优先用 HD 封面，fallback 到 LetPub 小图，都没有就不渲染
  const coverHtml = renderCoverHero(cover);
  if (coverHtml) {
    sections.push(coverHtml);
  } else if (journal.coverUrl && !journal.coverUrl.startsWith("data:")) {
    // cover-fetcher 没拿到但 journal.coverUrl 有值 → 直接用 LetPub 小图
    sections.push(
      `<section style="margin:12px 0;text-align:center;">` +
      `<img src="${esc(journal.coverUrl)}" style="max-width:150px;height:auto;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:block;margin:0 auto;" />` +
      `</section>`
    );
  }

  // 区块 3: 名片卡（渐变背景）
  sections.push(renderJournalCard(journal, theme));

  // 区块 4: 核心数据四宫格 — 按卖点排序
  const topSelling = sellingPoints[0]?.type;
  if (topSelling === "if_rising" || narrative === "story") {
    sections.push(renderIFTrendChart(journal));
    sections.push(renderCoreStats(journal, theme));
  } else {
    sections.push(renderCoreStats(journal, theme));
    sections.push(renderIFTrendChart(journal));
  }

  // 区块 5: 小编点评
  if (aiContent.editorComment) sections.push(renderEditorComment(aiContent.editorComment, theme));

  // 区块 6: 开场钩子
  sections.push(renderOpeningHook(journal, aiContent, sellingPoints, narrative, theme));

  // 区块 7: 影响因子与分区
  sections.push(renderIFOverview(journal, aiContent, theme));

  // 区块 9: 分区详情
  sections.push(renderPartitionDetail(journal, theme));

  // 区块 10: 划重点
  if (aiContent.highlightTip) sections.push(renderHighlightBox(aiContent.highlightTip, theme));

  // 区块 11-12: 审稿/发文（按卖点排序）
  const pointTypes = new Set(sellingPoints.slice(0, 3).map(p => p.type));
  if (pointTypes.has("fast_review")) {
    sections.push(renderReviewCycle(journal, theme));
    sections.push(renderPublicationStats(journal, theme));
  } else {
    sections.push(renderPublicationStats(journal, theme));
    sections.push(renderReviewCycle(journal, theme));
  }
  sections.push(renderPubVolumeChart(journal));

  // 收稿范围
  if (aiContent.scopeDescription) sections.push(renderScope(journal, aiContent.scopeDescription, theme));

  // 版面费
  sections.push(renderAPC(journal, theme, pointTypes.has("no_apc")));

  // 自引率
  if (journal.selfCitationRate != null) sections.push(renderSelfCitation(journal, theme));

  // 预警名单
  sections.push(renderWarning(journal, theme));

  // 基本信息
  sections.push(renderBasicInfoTable(journal));

  // 推荐指数
  sections.push(renderRating(aiContent, theme));

  // 来源引用
  sections.push(renderSourceLine());

  // 名片卡
  sections.push(renderServiceCard(theme));

  // 品牌底部
  sections.push(renderBrandLine());

  const body = sections.filter(Boolean).join("\n");
  return `<section style="max-width:640px;margin:0 auto;padding:0 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB',sans-serif;color:#333;font-size:15px;line-height:1.8;">\n${body}\n</section>`;
}
