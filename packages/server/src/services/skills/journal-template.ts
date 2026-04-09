/**
 * 期刊推荐文章模板 V9 —— 多主题多排版版
 *
 * V9 新增：
 * - 多套配色主题（学科自动匹配：医学红、工科蓝、社科绿、理学紫、生物青）
 * - 阅读节奏增强（小编点评框、划重点高亮框、装饰分割线）
 * - 数据看板 / 名片卡 / Banner 随主题变色
 * - 公众号兼容：只用 inline style，不用 class/id/外部 CSS
 */

import type { JournalInfo, CollectionResult } from "../data-collection/journal-content-collector.js";
import {
  generateIFTrendChart,
  generatePubVolumeChart,
  generateCASPartitionTable,
  generateJCRPartitionTable,
  svgToDataUri,
} from "../crawler/journal-chart-generator.js";


// 微信公众号二维码 base64（180x180 PNG）
const WECHAT_QR_BASE64 = "data:image/png;base64,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";

// ============ 多主题配色系统 ============

interface ThemeColors {
  name: string;
  /** 头部渐变 */
  headerGradient: string;
  /** 主色 */
  primary: string;
  /** 浅色 */
  primaryLight: string;
  /** 极浅色背景 */
  primaryBg: string;
  /** 边框色 */
  primaryBorder: string;
  /** 强调色（星星等） */
  accent: string;
  /** 左侧边框强调色 */
  sideBar: string;
  /** 看板背景色 */
  dashboardBg: string;
  /** 分割线装饰色 */
  dividerColor: string;
}

const THEMES: Record<string, ThemeColors> = {
  medical: {
    name: "医学红",
    headerGradient: "linear-gradient(135deg,#b91c1c 0%,#dc2626 50%,#ef4444 100%)",
    primary: "#c41e3a",
    primaryLight: "#fecaca",
    primaryBg: "#fef2f2",
    primaryBorder: "#fecaca",
    accent: "#dc2626",
    sideBar: "#c41e3a",
    dashboardBg: "#fef2f2",
    dividerColor: "#c41e3a",
  },
  engineering: {
    name: "工科蓝",
    headerGradient: "linear-gradient(135deg,#1e40af 0%,#2563eb 50%,#3b82f6 100%)",
    primary: "#1d4ed8",
    primaryLight: "#bfdbfe",
    primaryBg: "#eff6ff",
    primaryBorder: "#bfdbfe",
    accent: "#2563eb",
    sideBar: "#1d4ed8",
    dashboardBg: "#eff6ff",
    dividerColor: "#2563eb",
  },
  social: {
    name: "社科绿",
    headerGradient: "linear-gradient(135deg,#166534 0%,#16a34a 50%,#22c55e 100%)",
    primary: "#15803d",
    primaryLight: "#bbf7d0",
    primaryBg: "#f0fdf4",
    primaryBorder: "#bbf7d0",
    accent: "#16a34a",
    sideBar: "#15803d",
    dashboardBg: "#f0fdf4",
    dividerColor: "#16a34a",
  },
  science: {
    name: "理学紫",
    headerGradient: "linear-gradient(135deg,#6b21a8 0%,#7c3aed 50%,#8b5cf6 100%)",
    primary: "#7c3aed",
    primaryLight: "#ddd6fe",
    primaryBg: "#f5f3ff",
    primaryBorder: "#ddd6fe",
    accent: "#7c3aed",
    sideBar: "#6d28d9",
    dashboardBg: "#f5f3ff",
    dividerColor: "#7c3aed",
  },
  biology: {
    name: "生物青",
    headerGradient: "linear-gradient(135deg,#0e7490 0%,#0891b2 50%,#06b6d4 100%)",
    primary: "#0e7490",
    primaryLight: "#a5f3fc",
    primaryBg: "#ecfeff",
    primaryBorder: "#a5f3fc",
    accent: "#0891b2",
    sideBar: "#0e7490",
    dashboardBg: "#ecfeff",
    dividerColor: "#0891b2",
  },
};

/** 根据学科自动选择配色主题 */
function resolveTheme(discipline: string | null | undefined): ThemeColors {
  const d = (discipline || "").toLowerCase();
  if (d.includes("医") || d.includes("临床") || d.includes("药") || d.includes("肿瘤") || d.includes("血液") || d.includes("护理") || d.includes("hematol") || d.includes("oncol") || d.includes("medic") || d.includes("pharm")) {
    return THEMES.medical;
  }
  if (d.includes("工") || d.includes("计算") || d.includes("电") || d.includes("材料") || d.includes("机械") || d.includes("土木") || d.includes("engin") || d.includes("comput") || d.includes("electr")) {
    return THEMES.engineering;
  }
  if (d.includes("经济") || d.includes("管理") || d.includes("社会") || d.includes("教育") || d.includes("法") || d.includes("心理") || d.includes("econom") || d.includes("manag") || d.includes("social") || d.includes("educ") || d.includes("psychol")) {
    return THEMES.social;
  }
  if (d.includes("物理") || d.includes("数学") || d.includes("化学") || d.includes("天文") || d.includes("phys") || d.includes("math") || d.includes("chem") || d.includes("astro")) {
    return THEMES.science;
  }
  if (d.includes("生物") || d.includes("环境") || d.includes("农") || d.includes("生态") || d.includes("海洋") || d.includes("biol") || d.includes("environ") || d.includes("ecol") || d.includes("agri")) {
    return THEMES.biology;
  }
  // 默认红色
  return THEMES.medical;
}

// ============ AI 生成内容接口 ============

export interface AIGeneratedContent {
  title: string;           // 吸引眼球的文章标题
  scopeDescription: string; // 收稿范围描述
  recommendation: string;   // 推荐指数+总结
  ifPrediction?: string;    // IF 预测语句（如 "预测今年涨至15"）
  rating?: number;          // 推荐星级 1-5
  editorComment?: string;   // 小编点评（口语化一句话）
  highlightTip?: string;    // 划重点提示
}

// ============ 叙事风格定义 ============

type NarrativeStyle = "review" | "qa" | "story" | "ranking";

const NARRATIVE_LABELS: Record<NarrativeStyle, string> = {
  review: "测评体",   // 像数码测评一样讲期刊
  qa: "问答体",       // 用读者常见问题串联内容
  story: "故事体",     // 讲期刊崛起史/数据变化的故事
  ranking: "盘点体",   // 用排行榜/评分卡的形式
};

/** 根据期刊数据特征选择最合适的叙事风格 */
function chooseNarrative(j: JournalInfo): NarrativeStyle {
  // IF 数据丰富且增长明显 → 故事体（讲崛起史）
  if (j.ifHistory && j.ifHistory.length >= 5) {
    const first = j.ifHistory[0].value;
    const last = j.ifHistory[j.ifHistory.length - 1].value;
    if (last / first >= 2) return "story";
  }
  // 分区数据丰富 → 盘点体
  if (j.letpubCasPartitions?.length && j.letpubJcrPartitions?.length) return "ranking";
  // 审稿快或录用率高 → 问答体（回答"好投吗"）
  if (j.reviewCycle || j.acceptanceRate) return "qa";
  // 默认测评体
  return "review";
}

// ============ 智能卖点分析 ============

interface SellingPoint {
  type: "if_high" | "if_rising" | "fast_review" | "high_acceptance" | "top_partition" | "no_apc" | "safe_warning";
  score: number;     // 卖点强度 0-100
  headline: string;  // 一句话总结
}

function analyzeSellingPoints(j: JournalInfo): SellingPoint[] {
  const points: SellingPoint[] = [];
  const isDomestic = !!(j.catalogs?.length || j.cnNumber || j.compositeIF);

  // IF 绝对值高（国际 IF）
  if (j.impactFactor != null && j.impactFactor >= 5) {
    const score = Math.min(100, j.impactFactor * 5);
    points.push({ type: "if_high", score, headline: `影响因子 ${j.impactFactor.toFixed(1)}，${j.impactFactor >= 10 ? "顶刊级别" : "高水平期刊"}` });
  }

  // 国内复合影响因子（当没有国际 IF 时）
  if (j.impactFactor == null && j.compositeIF != null && j.compositeIF >= 1) {
    const score = Math.min(90, j.compositeIF * 20);
    points.push({ type: "if_high", score, headline: `复合影响因子 ${j.compositeIF.toFixed(3)}，国内同领域领先` });
  }

  // IF 增长趋势
  if (j.ifHistory && j.ifHistory.length >= 4) {
    const first = j.ifHistory[0].value;
    const last = j.ifHistory[j.ifHistory.length - 1].value;
    const growthRate = (last - first) / first;
    if (growthRate >= 0.5) {
      points.push({ type: "if_rising", score: Math.min(100, growthRate * 80), headline: `IF ${first.toFixed(1)}→${last.toFixed(1)}，${(growthRate * 100).toFixed(0)}% 增长` });
    }
  }

  // 审稿快
  if (j.reviewCycle) {
    const match = j.reviewCycle.match(/(\d+)/);
    if (match) {
      const days = parseInt(match[1]);
      if (days <= 30) points.push({ type: "fast_review", score: 90, headline: `审稿仅 ${j.reviewCycle}，极速出结果` });
      else if (days <= 60) points.push({ type: "fast_review", score: 65, headline: `审稿周期 ${j.reviewCycle}，效率较高` });
    }
  }

  // 录用率友好
  if (j.acceptanceRate != null) {
    const rate = j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100;
    if (rate >= 25) points.push({ type: "high_acceptance", score: 70, headline: `录用率约 ${rate.toFixed(0)}%，对投稿者友好` });
  }

  // 顶级分区（国际）
  if (j.casPartition?.includes("1区") || j.partition?.includes("Q1")) {
    const isTop = j.casPartitionNew?.includes("TOP");
    points.push({ type: "top_partition", score: isTop ? 95 : 80, headline: `${j.casPartition || j.partition}${isTop ? " TOP" : ""}，学术认可度极高` });
  }

  // ===== 国内核心期刊卖点 =====
  const cats = new Set(j.catalogs || []);

  // 北大核心 — 国内最权威的综合目录
  if (cats.has("pku-core")) {
    points.push({ type: "top_partition", score: 88, headline: "北大核心收录，国内学术认可度极高" });
  }

  // CSSCI — 社科领域的金标准
  if (cats.has("cssci")) {
    points.push({ type: "top_partition", score: 85, headline: "CSSCI（南大核心）收录，社科领域权威" });
  }

  // CSCD — 理工科权威
  if (cats.has("cscd")) {
    points.push({ type: "top_partition", score: 83, headline: "CSCD 收录，中国科学引文数据库权威认证" });
  }

  // 科技核心（CSTPCD）
  if (cats.has("cstpcd")) {
    points.push({ type: "top_partition", score: 60, headline: "科技核心（统计源）期刊，科研成果认可" });
  }

  // 双核心（同时被北大核心 + CSSCI/CSCD）
  if (cats.has("pku-core") && (cats.has("cssci") || cats.has("cscd"))) {
    // 用 safe_warning type 避免和上面重复 type 导致模板问题
    points.push({ type: "safe_warning", score: 92, headline: "双核心期刊，学术界广泛认可" });
  }

  // 免版面费
  if (j.apcFee === 0 || j.apcFee == null) {
    points.push({ type: "no_apc", score: isDomestic ? 65 : 55, headline: isDomestic ? "无版面费或版面费低，投稿成本友好" : "无需版面费，零成本发表" });
  }

  // 不在预警名单
  if (!j.isWarningList) {
    points.push({ type: "safe_warning", score: 40, headline: "不在预警名单，安全放心" });
  }

  // 国内期刊历史悠久（创刊早）
  if (isDomestic && j.foundingYear && j.foundingYear <= 1980) {
    points.push({ type: "safe_warning", score: 45, headline: `${j.foundingYear}年创刊，${new Date().getFullYear() - j.foundingYear}年办刊历史` });
  }

  // 按得分排序
  return points.sort((a, b) => b.score - a.score);
}

// ============ 主入口 ============

/**
 * 生成完整的期刊推荐文章 HTML（V9 —— 智能排版引擎）
 *
 * 核心逻辑：
 * 1. 分析期刊卖点 → 决定内容优先级
 * 2. 选择叙事风格 → 决定开场方式和段落衔接
 * 3. 组装内容 → 卖点前置 + 数据呈现多样化 + 节奏穿插
 */
export function generateJournalArticleHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  abstracts?: CollectionResult["abstracts"]
): string {
  const theme = resolveTheme(journal.discipline);
  const narrative = chooseNarrative(journal);
  const sellingPoints = analyzeSellingPoints(journal);
  const sections: string[] = [];

  // ===== 合成期刊警示 =====
  if (journal.synthetic) {
    sections.push(`
<div style="margin-bottom:16px;padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;display:flex;align-items:center;gap:8px;">
  <span style="font-size:18px;">⚠️</span>
  <span style="font-size:13px;color:#92400e;line-height:1.6;">以下期刊信息由 AI 智能推荐生成，<strong>仅供参考</strong>。具体数据请以官方来源（知网、LetPub、JCR 等）为准，投稿前务必自行核实。</span>
</div>`);
  }

  // ===== 封面大图（官方期刊封面，增强权威感）=====
  sections.push(buildCoverHero(journal, theme));

  // ===== 第一屏：核心视觉（始终在最上面）=====
  sections.push(buildJournalCard(journal, theme));

  // ===== 第二区：开场钩子（根据叙事风格不同）=====
  sections.push(buildOpeningHook(journal, aiContent, sellingPoints, narrative, theme));

  // ===== 第三区：核心数据（根据卖点选择呈现方式）=====
  const topSelling = sellingPoints[0]?.type;

  if (topSelling === "if_rising" || narrative === "story") {
    // 卖点是IF增长 或 故事体 → 先讲趋势图 + 增长故事
    sections.push(buildIFTrendSection(journal));
    sections.push(buildDataDashboard(journal, theme));
  } else if (topSelling === "if_high" || topSelling === "top_partition") {
    // 卖点是IF高或分区好 → 先数据看板（大字突出）
    sections.push(buildDataDashboard(journal, theme));
    sections.push(buildIFTrendSection(journal));
  } else {
    // 其他 → 先看板再图
    sections.push(buildDataDashboard(journal, theme));
    sections.push(buildIFTrendSection(journal));
  }

  // 小编点评（第一个节奏点）
  if (aiContent.editorComment) {
    sections.push(buildEditorComment(aiContent.editorComment, theme));
  }

  // ===== 第四区：详细分析（根据卖点排序）=====

  // 卖点驱动的内容排序
  const detailSections = buildOrderedDetailSections(journal, aiContent, sellingPoints, narrative, theme);
  sections.push(...detailSections);

  // ===== 第五区：收尾（推荐 + 钩子）=====
  sections.push(buildRecommendationSection(journal, aiContent, theme));
  sections.push(buildFooter(undefined, theme));

  return `<div style="max-width:680px;margin:0 auto;font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif;color:#333;line-height:2;font-size:15px;">\n${sections.filter(Boolean).join("\n")}\n</div>`;
}

/**
 * 开场钩子 — 根据叙事风格生成不同的开头
 */
function buildOpeningHook(
  j: JournalInfo, ai: AIGeneratedContent, points: SellingPoint[],
  narrative: NarrativeStyle, theme: ThemeColors
): string {
  const top3 = points.slice(0, 3).map(p => p.headline);

  if (narrative === "story") {
    // 故事体开场：讲数据变化的故事
    const first = j.ifHistory?.[0];
    const last = j.ifHistory?.[j.ifHistory.length - 1];
    const storyText = first && last
      ? `从 ${first.year} 年的 IF ${first.value.toFixed(1)}，到 ${last.year} 年的 ${last.value.toFixed(1)}，《${esc(j.nameEn || j.name)}》用 ${last.year - first.year} 年完成了一场惊人的蜕变。`
      : `《${esc(j.nameEn || j.name)}》近年来表现亮眼。`;
    return `
<div style="margin-bottom:24px;padding:20px;background:${theme.primaryBg};border-radius:12px;border:1px solid ${theme.primaryBorder};">
  <p style="font-size:13px;color:${theme.accent};font-weight:bold;margin:0 0 8px;letter-spacing:2px;">📖 期刊崛起史</p>
  <p style="margin:0;font-size:16px;line-height:2;color:#333;">${storyText}</p>
  ${top3.length > 0 ? `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;">${top3.map(t => `<span style="display:inline-block;padding:4px 12px;background:${theme.primaryLight};color:${theme.primary};border-radius:20px;font-size:12px;font-weight:600;">${esc(t)}</span>`).join("")}</div>` : ""}
</div>`;
  }

  if (narrative === "qa") {
    // 问答体开场：用读者最关心的问题引入
    const questions = [];
    if (j.acceptanceRate != null) questions.push("好投吗？录用率如何？");
    if (j.reviewCycle) questions.push("审稿快不快？多久出结果？");
    if (j.impactFactor != null) questions.push("影响因子高不高？值得投吗？");
    if (j.apcFee != null) questions.push("版面费贵不贵？");
    const topQ = questions.slice(0, 3);
    return `
<div style="margin-bottom:24px;padding:20px;background:${theme.primaryBg};border-radius:12px;border:1px solid ${theme.primaryBorder};">
  <p style="font-size:13px;color:${theme.accent};font-weight:bold;margin:0 0 10px;letter-spacing:2px;">❓ 投稿前你最想知道</p>
  ${topQ.map((q, i) => `<p style="margin:0 0 4px;font-size:15px;color:#555;"><span style="display:inline-block;width:22px;height:22px;background:${theme.accent};color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:12px;margin-right:8px;">${i + 1}</span>${esc(q)}</p>`).join("\n  ")}
  <p style="margin:10px 0 0;font-size:13px;color:#999;">👇 带着这些问题往下看，一篇文章帮你全搞清楚</p>
</div>`;
  }

  if (narrative === "ranking") {
    // 盘点体开场：核心评分卡
    return `
<div style="margin-bottom:24px;padding:20px;background:${theme.primaryBg};border-radius:12px;border:1px solid ${theme.primaryBorder};">
  <p style="font-size:13px;color:${theme.accent};font-weight:bold;margin:0 0 12px;letter-spacing:2px;">📊 期刊综合评分卡</p>
  ${buildMiniScoreCard(j, theme)}
</div>`;
  }

  // review（测评体）开场：亮点 Tag 云
  return `
<div style="margin-bottom:24px;padding:20px;background:${theme.primaryBg};border-radius:12px;border:1px solid ${theme.primaryBorder};">
  <p style="font-size:13px;color:${theme.accent};font-weight:bold;margin:0 0 10px;letter-spacing:2px;">🔍 一分钟速览</p>
  <div style="display:flex;flex-wrap:wrap;gap:8px;">
    ${top3.map(t => `<span style="display:inline-block;padding:6px 14px;background:#fff;border:1px solid ${theme.primaryBorder};color:${theme.primary};border-radius:20px;font-size:13px;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,0.05);">${esc(t)}</span>`).join("\n    ")}
  </div>
</div>`;
}

/**
 * 迷你评分卡 — 盘点体专用，用进度条呈现多维评分
 */
function buildMiniScoreCard(j: JournalInfo, theme: ThemeColors): string {
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

  return metrics.map(m => `
  <div style="margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
      <span style="color:#666;">${esc(m.label)}</span>
      <span style="color:${theme.primary};font-weight:bold;">${esc(m.display)}</span>
    </div>
    <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
      <div style="width:${m.score}%;height:100%;background:${theme.accent};border-radius:4px;"></div>
    </div>
  </div>`).join("");
}

/**
 * 根据卖点排序生成详细分析区域
 *
 * 核心逻辑：卖点强的内容排前面，穿插节奏组件
 */
function buildOrderedDetailSections(
  j: JournalInfo, ai: AIGeneratedContent, points: SellingPoint[],
  narrative: NarrativeStyle, theme: ThemeColors
): string[] {
  const sections: string[] = [];
  const pointTypes = new Set(points.slice(0, 3).map(p => p.type));

  // ==== 根据卖点类型决定详细内容的顺序 ====

  // 影响因子与分区（始终有）
  sections.push(buildIFAndPartitionOverview(j, ai, theme));

  // 分区详情
  sections.push(buildPartitionDetailEnhanced(j, theme));

  // 划重点（第二个节奏点）
  if (ai.highlightTip) {
    sections.push(buildHighlightBox(ai.highlightTip, theme));
  }

  sections.push(buildDecorativeDivider(theme));

  // 审稿快是卖点 → 审稿周期提前
  if (pointTypes.has("fast_review")) {
    sections.push(buildReviewCycleSection(j, theme));
    sections.push(buildPublicationStats(j, theme));
    sections.push(buildPubVolumeTrendSection(j));
  } else {
    sections.push(buildPublicationStats(j, theme));
    sections.push(buildPubVolumeTrendSection(j));
    sections.push(buildReviewCycleSection(j, theme));
  }

  sections.push(buildDecorativeDivider(theme));

  // 收稿范围
  if (ai.scopeDescription) {
    sections.push(buildScopeSection(j, ai.scopeDescription, theme));
  }

  // 版面费 —— 免费则提前讲
  if (pointTypes.has("no_apc")) {
    // 已经是卖点了，用更强调的呈现
    sections.push(buildAPCSectionHighlight(j, theme));
  } else {
    sections.push(buildAPCSection(j, theme));
  }

  // 自引率
  if (j.selfCitationRate != null) {
    sections.push(buildSelfCitationSection(j));
  }

  // 预警名单
  sections.push(buildWarningSection(j));

  // 基本信息表（放末尾，像百科资料卡）
  sections.push(buildBasicInfoTable(j));

  return sections;
}

/**
 * 免版面费强调版 —— 卖点突出时使用
 */
function buildAPCSectionHighlight(j: JournalInfo, theme: ThemeColors): string {
  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("版面费", theme)}
  <div style="padding:18px;background:${theme.primaryBg};border-radius:10px;border:2px solid ${theme.primaryBorder};text-align:center;">
    <p style="margin:0 0 4px;font-size:28px;font-weight:900;color:${theme.accent};">FREE</p>
    <p style="margin:0;font-size:15px;color:#555;">本刊无需版面费，零成本发表！OA 期刊，全球开放获取。</p>
  </div>
</div>`;
}

// ============ 兼容旧接口 ============

export function generateJournalSectionHtml(
  journalData: CollectionResult,
  options?: { showAbstracts?: boolean; maxAbstracts?: number }
): string {
  if (!journalData || journalData.journals.length === 0) return "";
  const journal = journalData.journals[0];
  const defaultAI: AIGeneratedContent = {
    title: `期刊推荐：${journal.name}`,
    scopeDescription: "",
    recommendation: "",
  };
  return generateJournalArticleHtml(journal, defaultAI, journalData.abstracts);
}

// ============ 各段落构建 ============

/**
 * 期刊名片卡 — 文章顶部核心视觉（V10 专业可信版）
 *
 * 设计原则：
 * - 去掉假品牌卡，用权威标识（SCIE/SSCI/Scopus/PubMed）建立信任
 * - 信息层次：期刊名（第一眼）→ ISSN+出版商（可验证事实）→ IF 大字（核心数据）→ 收录标识（权威背书）
 * - 白底 + 主题色点缀，学术感而非营销感
 */
/**
 * 封面大图 Hero — 全幅展示官方期刊封面，增强权威感
 * 如果有 coverUrl → 渲染全宽封面 + 期刊名叠加
 * 如果有 dataCardUri → 渲染数据信息卡片
 * 都没有 → 返回空（不渲染）
 */
function buildCoverHero(j: JournalInfo, theme: ThemeColors): string {
  const imgSrc = j.coverUrl || j.dataCardUri;
  if (!imgSrc) return "";

  const displayName = j.nameEn || j.name;
  const isDataCard = !j.coverUrl && !!j.dataCardUri;

  // 数据卡片用不同样式（不需要叠加文字）
  if (isDataCard) {
    return `
<div style="margin-bottom:20px;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
  <img src="${esc(imgSrc)}" alt="${esc(displayName)}" style="width:100%;display:block;" />
</div>`;
  }

  // 官方封面：全宽图片 + 底部渐变叠加期刊名和官方标识
  return `
<div style="margin-bottom:20px;border-radius:14px;overflow:hidden;position:relative;box-shadow:0 4px 20px rgba(0,0,0,0.12);">
  <img src="${esc(imgSrc)}" alt="${esc(displayName)}" style="width:100%;display:block;min-height:200px;object-fit:cover;" onerror="this.parentElement.style.display='none'" />
  <div style="position:absolute;bottom:0;left:0;right:0;padding:40px 20px 16px;background:linear-gradient(transparent,rgba(0,0,0,0.7));">
    <p style="font-size:20px;font-weight:800;color:#fff;margin:0 0 4px;text-shadow:0 1px 4px rgba(0,0,0,0.5);line-height:1.4;">${esc(displayName)}</p>
    ${j.publisher ? `<p style="font-size:12px;color:rgba(255,255,255,0.85);margin:0;text-shadow:0 1px 2px rgba(0,0,0,0.4);">${esc(j.publisher)}</p>` : ""}
  </div>
  <div style="position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.92);padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;color:${theme.primary};box-shadow:0 2px 8px rgba(0,0,0,0.15);">
    Official Cover
  </div>
</div>`;
}

function buildJournalCard(j: JournalInfo, theme: ThemeColors): string {
  const displayName = j.nameEn || j.name;

  // ---- 影响因子：国际 IF 优先，国内复合 IF 作为 fallback ----
  const isDomestic = !!(j.catalogs?.length || j.cnNumber || j.compositeIF);
  let ifText: string | null = null;
  let ifLabel = "Impact Factor";
  if (j.impactFactor != null) {
    ifText = j.impactFactor.toFixed(1);
  } else if (j.compositeIF != null) {
    ifText = j.compositeIF.toFixed(3);
    ifLabel = "复合影响因子";
  } else if (j.comprehensiveIF != null) {
    ifText = j.comprehensiveIF.toFixed(3);
    ifLabel = "综合影响因子";
  }
  const ifColor = j.impactFactor != null ? getIfColor(j.impactFactor) : (ifText ? "#c2410c" : "#6b7280");

  // ---- 推断收录数据库标识 ----
  const indexBadges = inferIndexBadges(j);
  const badgeHtml = indexBadges.map(b =>
    `<span style="display:inline-block;padding:3px 10px;background:${b.bg};color:${b.color};border:1px solid ${b.border};border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.5px;">${esc(b.label)}</span>`
  ).join("\n        ");

  // ---- 分区/核心级别标签 ----
  const partition = j.casPartition || j.partition || "";
  const partitionNew = j.casPartitionNew || "";
  const isTop = partitionNew.toUpperCase().includes("TOP");

  // ---- 封面图（如有） ----
  const coverImg = j.coverUrl
    ? `<div style="flex-shrink:0;">
        <img src="${esc(j.coverUrl)}" alt="${esc(displayName)}" style="width:90px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;display:block;" onerror="this.parentElement.style.display='none'" />
      </div>`
    : "";

  return `
<div style="margin-bottom:24px;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
  <div style="background:${theme.headerGradient};padding:16px 20px;text-align:center;">
    <p style="font-size:12px;color:rgba(255,255,255,0.8);margin:0;letter-spacing:3px;">JOURNAL RECOMMENDATION</p>
  </div>

  <div style="background:#fff;padding:20px;">
    <div style="display:flex;gap:16px;align-items:flex-start;">
      ${coverImg}
      <div style="flex:1;min-width:0;">
        <h1 style="font-size:20px;color:#1a1a1a;margin:0 0 6px;font-weight:800;line-height:1.4;word-break:break-word;">${esc(displayName)}</h1>
        ${j.abbreviation ? `<p style="font-size:13px;color:#888;margin:0 0 4px;font-style:italic;">${esc(j.abbreviation)}</p>` : ""}
        <div style="font-size:12px;color:#999;margin:0;">
          ${j.issn ? `<span>ISSN: ${esc(j.issn)}</span>` : ""}
          ${j.cnNumber ? `<span style="margin:0 6px;color:#ddd;">|</span><span>CN: ${esc(j.cnNumber)}</span>` : ""}
          ${(j.issn || j.cnNumber) && (j.organizerName || j.publisher) ? `<span style="margin:0 6px;color:#ddd;">|</span>` : ""}
          ${j.organizerName ? `<span>${esc(j.organizerName)}</span>` : (j.publisher ? `<span>${esc(j.publisher)}</span>` : "")}
          ${j.country ? `<span style="margin:0 6px;color:#ddd;">|</span><span>${esc(j.country)}</span>` : ""}
        </div>
      </div>
    </div>

    <div style="margin-top:16px;padding-top:16px;border-top:1px solid #f0f0f0;">
      <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;">
        ${ifText ? `<div>
          <div style="font-size:11px;color:#999;letter-spacing:0.5px;margin-bottom:2px;">${esc(ifLabel)}</div>
          <div style="font-size:${j.impactFactor != null ? "36" : "28"}px;font-weight:900;color:${ifColor};line-height:1;">${ifText}</div>
        </div>` : ""}

        ${partition ? `<div>
          <div style="font-size:11px;color:#999;margin-bottom:4px;">中科院分区</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:18px;font-weight:800;color:${getPartitionColor(partition)};">${esc(partition)}</span>
            ${isTop ? `<span style="display:inline-block;padding:2px 8px;background:#dc2626;color:#fff;border-radius:3px;font-size:10px;font-weight:700;">TOP</span>` : ""}
          </div>
        </div>` : (j.coreLevel ? `<div>
          <div style="font-size:11px;color:#999;margin-bottom:4px;">核心级别</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:18px;font-weight:800;color:#991b1b;">${esc(j.coreLevel)}</span>
          </div>
        </div>` : "")}

        ${j.foundingYear ? `<div>
          <div style="font-size:11px;color:#999;margin-bottom:4px;">创刊年份</div>
          <div style="font-size:18px;font-weight:700;color:#333;">${j.foundingYear}</div>
        </div>` : ""}
      </div>
    </div>

    ${indexBadges.length > 0 ? `
    <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:6px;">
      ${badgeHtml}
    </div>` : ""}
  </div>
</div>`;
}

/**
 * 从期刊数据中推断收录数据库标识
 * 返回可信的权威标识列表（只推断有依据的，不编造）
 */
function inferIndexBadges(j: JournalInfo): Array<{ label: string; bg: string; color: string; border: string }> {
  const badges: Array<{ label: string; bg: string; color: string; border: string }> = [];
  const dbSet = new Set<string>();

  // 从 JCR 分区数据中提取 database 字段（最可靠来源）
  if (j.letpubJcrPartitions) {
    for (const p of j.letpubJcrPartitions) {
      if (p.database) dbSet.add(p.database.toUpperCase());
    }
  }
  if (j.letpubJciPartitions) {
    for (const p of j.letpubJciPartitions) {
      if (p.database) dbSet.add(p.database.toUpperCase());
    }
  }

  // SCIE（深蓝色 — 最权威的理工科标识）
  if (dbSet.has("SCIE") || dbSet.has("SCI")) {
    badges.push({ label: "SCIE 收录", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" });
  }

  // SSCI（绿色 — 社科权威标识）
  if (dbSet.has("SSCI")) {
    badges.push({ label: "SSCI 收录", bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" });
  }

  // AHCI（紫色 — 人文艺术标识）
  if (dbSet.has("AHCI")) {
    badges.push({ label: "AHCI 收录", bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe" });
  }

  // EI（橙色 — 工程索引）
  if (dbSet.has("EI") || dbSet.has("COMPENDEX")) {
    badges.push({ label: "EI 收录", bg: "#fff7ed", color: "#c2410c", border: "#fed7aa" });
  }

  // 如果没有从分区数据中拿到，尝试从分区名称推断
  if (badges.length === 0) {
    const partText = (j.casPartition || "") + (j.partition || "");
    if (/Q[1-4]/i.test(partText) || /[1-4]区/.test(partText)) {
      badges.push({ label: "SCI 收录", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" });
    }
  }

  // ===== 国内核心目录标识（从 catalogs 数组读取，数据来自知网/万方爬虫） =====
  const cats = new Set(j.catalogs || []);

  // 北大核心（深红 — 国内最权威的综合目录之一）
  if (cats.has("pku-core")) {
    badges.push({ label: "北大核心", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" });
  }
  // CSSCI（橙色 — 南大核心，社科权威）
  if (cats.has("cssci")) {
    badges.push({ label: "CSSCI", bg: "#fff7ed", color: "#9a3412", border: "#fed7aa" });
  }
  // CSCD（深蓝 — 中国科学引文数据库）
  if (cats.has("cscd")) {
    badges.push({ label: "CSCD", bg: "#eff6ff", color: "#1e3a5f", border: "#bfdbfe" });
  }
  // CSTPCD（科技核心）
  if (cats.has("cstpcd")) {
    badges.push({ label: "科技核心", bg: "#f0fdf4", color: "#14532d", border: "#bbf7d0" });
  }
  // AMI 综合评价
  if (cats.has("ami")) {
    badges.push({ label: "AMI 入选", bg: "#f5f3ff", color: "#4c1d95", border: "#ddd6fe" });
  }
  // EI（从 catalogs 补充）
  if (cats.has("ei") && !badges.some(b => b.label.includes("EI"))) {
    badges.push({ label: "EI 收录", bg: "#fff7ed", color: "#c2410c", border: "#fed7aa" });
  }

  // PubMed（从学科推断：医学/生物/药学类大概率被 PubMed 收录）
  const disc = (j.discipline || "").toLowerCase();
  if (disc.includes("医") || disc.includes("生物") || disc.includes("药") ||
      disc.includes("medic") || disc.includes("biol") || disc.includes("pharm") ||
      disc.includes("oncol") || disc.includes("neurol")) {
    badges.push({ label: "PubMed", bg: "#fefce8", color: "#a16207", border: "#fde68a" });
  }

  // Open Access
  if (j.apcFee && j.apcFee > 0) {
    badges.push({ label: "Open Access", bg: "#fef2f2", color: "#b91c1c", border: "#fecaca" });
  }

  return badges;
}

function buildBasicInfoTable(j: JournalInfo): string {
  const displayName = j.nameEn || j.name;
  const rows: string[] = [];

  rows.push(infoRow("期刊全称", displayName));
  if (j.nameEn && j.name !== j.nameEn) rows.push(infoRow("中文名称", j.name));
  if (j.abbreviation) rows.push(infoRow("简称", j.abbreviation));
  if (j.foundingYear) rows.push(infoRow("创刊时间", `${j.foundingYear}年`));
  if (j.country) rows.push(infoRow("出版国家", j.country));
  if (j.publisher) rows.push(infoRow("出版商", j.publisher));
  if (j.organizerName) rows.push(infoRow("主办单位", j.organizerName));
  if (j.supervisorName) rows.push(infoRow("主管单位", j.supervisorName));
  if (j.issn) rows.push(infoRow("ISSN", j.issn));
  if (j.cnNumber) rows.push(infoRow("CN 刊号", j.cnNumber));
  if (j.frequency) rows.push(infoRow("刊期", j.frequency));
  if (j.website) rows.push(infoRow("期刊官网", `<a href="${esc(j.website)}" style="color:#4f46e5;text-decoration:underline;">${esc(j.website)}</a>`));
  if (j.cnkiUrl) rows.push(infoRow("知网主页", `<a href="${esc(j.cnkiUrl)}" style="color:#4f46e5;text-decoration:underline;">查看知网页面</a>`));

  return `
<div style="margin-bottom:24px;">
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>
</div>`;
}

/**
 * 核心数据看板 — 纯 CSS 四格指标卡
 * 文章中最重要的视觉元素，替代旧的 SVG 数据卡片
 */
function buildDataDashboard(j: JournalInfo, theme: ThemeColors): string {
  const cards: string[] = [];

  // IF 卡片（大字突出）— 国际 IF 优先，国内复合/综合 IF 作为 fallback
  if (j.impactFactor != null) {
    const ifColor = getIfColor(j.impactFactor);
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">IMPACT FACTOR</div>
        <div style="font-size:36px;font-weight:900;color:${ifColor};line-height:1;margin-bottom:4px;">${j.impactFactor.toFixed(1)}</div>
        <div style="font-size:11px;color:#94a3b8;">影响因子</div>
      </div>`);
  } else if (j.compositeIF != null) {
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">复合影响因子</div>
        <div style="font-size:30px;font-weight:900;color:#c2410c;line-height:1;margin-bottom:4px;">${j.compositeIF.toFixed(3)}</div>
        <div style="font-size:11px;color:#94a3b8;">知网数据</div>
      </div>`);
  } else if (j.comprehensiveIF != null) {
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">综合影响因子</div>
        <div style="font-size:30px;font-weight:900;color:#c2410c;line-height:1;margin-bottom:4px;">${j.comprehensiveIF.toFixed(3)}</div>
        <div style="font-size:11px;color:#94a3b8;">知网数据</div>
      </div>`);
  }

  // 分区卡片 / 核心级别卡片
  const partition = j.casPartition || j.partition;
  if (partition) {
    const pColor = getPartitionColor(partition);
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">PARTITION</div>
        <div style="font-size:28px;font-weight:900;color:${pColor};line-height:1;margin-bottom:4px;">${esc(partition)}</div>
        <div style="font-size:11px;color:#94a3b8;">${j.casPartition ? "中科院分区" : "JCR分区"}</div>
      </div>`);
  } else if (j.coreLevel) {
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">核心级别</div>
        <div style="font-size:22px;font-weight:900;color:#991b1b;line-height:1;margin-bottom:4px;">${esc(j.coreLevel)}</div>
        <div style="font-size:11px;color:#94a3b8;">国内核心</div>
      </div>`);
  }

  // 录用率卡片
  if (j.acceptanceRate != null) {
    const ratePercent = j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100;
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">ACCEPTANCE</div>
        <div style="font-size:28px;font-weight:900;color:#2563eb;line-height:1;margin-bottom:4px;">${ratePercent.toFixed(0)}%</div>
        <div style="font-size:11px;color:#94a3b8;">录用率</div>
      </div>`);
  }

  // 审稿周期卡片
  if (j.reviewCycle) {
    cards.push(`
      <div style="flex:1;min-width:130px;padding:16px 12px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #f1f5f9;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:1px;">REVIEW</div>
        <div style="font-size:20px;font-weight:900;color:#059669;line-height:1.2;margin-bottom:4px;">${esc(j.reviewCycle)}</div>
        <div style="font-size:11px;color:#94a3b8;">审稿周期</div>
      </div>`);
  }

  if (cards.length === 0) return "";

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("核心数据一览", theme)}
  <div style="display:flex;gap:12px;flex-wrap:wrap;padding:16px;background:${theme.dashboardBg};border-radius:12px;">
    ${cards.join("")}
  </div>
</div>`;
}

function buildIFAndPartitionOverview(j: JournalInfo, ai: AIGeneratedContent, theme: ThemeColors): string {
  const isDomestic = !!(j.catalogs?.length || j.cnNumber || j.compositeIF);

  let content = `《${esc(j.nameEn || j.name)}》`;

  // ---- 影响因子描述 ----
  if (j.impactFactor != null) {
    const ifText = j.impactFactor.toFixed(1);
    content += `最新影响因子为 <strong style="color:${theme.primary};font-size:18px;">${ifText}</strong> 分`;
    if (ai.ifPrediction) content += `（${esc(ai.ifPrediction)}）`;
    content += `！`;
  } else if (j.compositeIF != null) {
    content += `复合影响因子为 <strong style="color:${theme.primary};font-size:18px;">${j.compositeIF.toFixed(3)}</strong>`;
    if (j.comprehensiveIF != null) content += `，综合影响因子 <strong>${j.comprehensiveIF.toFixed(3)}</strong>`;
    content += `（知网数据）。`;
  } else if (j.comprehensiveIF != null) {
    content += `综合影响因子为 <strong style="color:${theme.primary};font-size:18px;">${j.comprehensiveIF.toFixed(3)}</strong>（知网数据）。`;
  }

  // ---- 分区 / 核心级别描述 ----
  if (j.casPartition) {
    content += `中科院分区 <strong>${esc(j.casPartition)}</strong>`;
    if (j.casPartitionNew) content += `（新锐分区 <strong>${esc(j.casPartitionNew)}</strong>）`;
    content += `。`;
  } else if (j.partition) {
    content += `JCR 分区 <strong style="color:${getPartitionColor(j.partition)};">${esc(j.partition)}</strong>。`;
  } else if (j.coreLevel) {
    content += `属于 <strong style="color:#991b1b;">${esc(j.coreLevel)}</strong> 期刊`;
    const cats = j.catalogs || [];
    if (cats.length > 0) {
      const catLabels = cats.map(c => {
        const map: Record<string, string> = { "pku-core": "北大核心", cssci: "CSSCI", cscd: "CSCD", cstpcd: "科技核心", ami: "AMI" };
        return map[c] || c;
      });
      content += `，被 ${catLabels.join("、")} 收录`;
    }
    content += `。`;
  }

  // ---- 学科定位 ----
  if (j.discipline) {
    content += `是${esc(j.discipline)}领域的`;
    if (isDomestic) {
      if (j.coreLevel?.includes("北大核心") || j.catalogs?.includes("cssci")) content += `国内权威核心期刊`;
      else if (j.catalogs?.length) content += `国内核心期刊`;
      else content += `重要学术期刊`;
    } else {
      if (j.impactFactor && j.impactFactor >= 10) content += `国际权威期刊`;
      else if (j.impactFactor && j.impactFactor >= 5) content += `高水平期刊`;
      else content += `重要学术期刊`;
    }
  }

  if (j.organizerName && isDomestic) {
    content += `，由${esc(j.organizerName)}主办`;
    if (j.supervisorName) content += `，${esc(j.supervisorName)}主管`;
    content += `。`;
  } else if (j.publisher) {
    content += `，由 ${esc(j.publisher)} 出版。`;
  }

  const sTitle = isDomestic ? "期刊概况与核心收录" : "影响因子与分区";

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle(sTitle, theme)}
  <div style="padding:16px 18px;background:#fff;border-radius:8px;border-left:4px solid ${theme.sideBar};box-shadow:0 1px 4px rgba(0,0,0,0.05);">
    <p style="margin:0;line-height:2;font-size:15px;">${content}</p>
  </div>
</div>`;
}

/**
 * 影响因子趋势图 — LetPub 风格蓝色柱状图
 * 数据来自 journal.ifHistory（LetPub 抓取）
 */
function buildIFTrendSection(j: JournalInfo): string {
  if (!j.ifHistory || j.ifHistory.length < 3) return "";

  const chartSvg = generateIFTrendChart(j.ifHistory);
  if (!chartSvg) return "";

  const chartUri = svgToDataUri(chartSvg);

  return `
<div style="margin-bottom:24px;text-align:center;">
  <img src="${chartUri}" alt="${esc(j.name)} 影响因子趋势" style="max-width:100%;height:auto;" />
</div>`;
}

/**
 * 增强版分区详情 — 优先用 LetPub 表格，fallback 到简单文字
 */
function buildPartitionDetailEnhanced(j: JournalInfo, theme: ThemeColors): string {
  const hasLetPubData =
    (j.letpubCasPartitions && j.letpubCasPartitions.length > 0) ||
    (j.letpubJcrPartitions && j.letpubJcrPartitions.length > 0);

  if (hasLetPubData) {
    let html = `
<div style="margin-bottom:24px;">
  ${sectionTitle("期刊分区", theme)}`;

    // 中科院分区表格
    if (j.letpubCasPartitions && j.letpubCasPartitions.length > 0) {
      html += `<div style="margin-bottom:16px;">${generateCASPartitionTable(j.letpubCasPartitions)}</div>`;
    }

    // JCR 分区标题 + 表格
    if (j.letpubJcrPartitions && j.letpubJcrPartitions.length > 0) {
      html += `
  <div style="text-align:center;margin:20px 0 12px;">
    <span style="font-size:18px;font-weight:bold;color:#333;">JCR分区</span>
  </div>
  <div style="margin-bottom:12px;">${generateJCRPartitionTable(j.letpubJcrPartitions, "JCR学科分类")}</div>`;
    }

    // JCI 分区表格
    if (j.letpubJciPartitions && j.letpubJciPartitions.length > 0) {
      html += `<div style="margin-bottom:12px;">${generateJCRPartitionTable(j.letpubJciPartitions, "JCI学科分类")}</div>`;
    }

    html += `</div>`;
    return html;
  }

  // Fallback：用旧的简单文字版
  return buildPartitionDetail(j, theme);
}

/**
 * 发文量趋势图 — LetPub 风格蓝色柱状图
 */
function buildPubVolumeTrendSection(j: JournalInfo): string {
  if (!j.pubVolumeHistory || j.pubVolumeHistory.length < 3) return "";

  const chartSvg = generatePubVolumeChart(j.pubVolumeHistory);
  if (!chartSvg) return "";

  const chartUri = svgToDataUri(chartSvg);

  return `
<div style="margin-bottom:24px;text-align:center;">
  <img src="${chartUri}" alt="${esc(j.name)} 发文量趋势" style="max-width:100%;height:auto;" />
</div>`;
}

function buildPartitionDetail(j: JournalInfo, theme: ThemeColors): string {
  const items: string[] = [];

  if (j.partition) {
    items.push(`<strong>JCR 分区：</strong><span style="color:${getPartitionColor(j.partition)};font-weight:bold;">${esc(j.partition)}</span>`);
  }

  if (j.jcrSubjects) {
    try {
      const subjects = JSON.parse(j.jcrSubjects) as Array<{ subject: string; rank: string; position?: string }>;
      for (const s of subjects) {
        const posText = s.position ? `（${s.position}）` : "";
        items.push(`${esc(s.subject)}：<strong style="color:${getPartitionColor(s.rank)};">${esc(s.rank)}</strong>${posText}`);
      }
    } catch { /* skip */ }
  }

  if (j.casPartition) {
    items.push(`<strong>中科院分区：</strong>${esc(j.casPartition)}`);
  }
  if (j.casPartitionNew) {
    items.push(`<strong>新锐分区：</strong>${esc(j.casPartitionNew)}`);
  }

  if (items.length === 0) return "";

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("期刊分区", theme)}
  <div style="padding:16px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
    ${items.map(item => `<p style="margin:0 0 6px;font-size:14px;">${item}</p>`).join("\n    ")}
  </div>
</div>`;
}

function buildPublicationStats(j: JournalInfo, theme: ThemeColors): string {
  const parts: string[] = [];

  parts.push(`《${esc(j.nameEn || j.name)}》`);

  if (j.annualVolume) {
    parts.push(`近年年发文量约 <strong>${j.annualVolume}</strong> 篇`);
  }

  if (j.acceptanceRate != null) {
    const ratePercent = j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100;
    parts.push(`整体录用率约为 <strong>${ratePercent.toFixed(0)}%</strong>`);
  }

  let institutionsHtml = "";
  if (j.topInstitutions) {
    try {
      const institutions = JSON.parse(j.topInstitutions) as string[];
      if (institutions.length > 0) {
        institutionsHtml = `<p style="margin:8px 0 0;font-size:14px;color:#555;">国内投稿活跃机构：${institutions.map(i => esc(i)).join("、")}等。</p>`;
      }
    } catch { /* skip */ }
  }

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("发文情况", theme)}
  <div style="padding:16px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
    <p style="margin:0;line-height:1.8;">${parts.join("，")}。</p>
    ${institutionsHtml}
  </div>
</div>`;
}

function buildScopeSection(_j: JournalInfo, scopeDescription: string, theme: ThemeColors): string {
  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("收稿范围", theme)}
  <div style="padding:16px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);line-height:2;">
    ${scopeDescription}
  </div>
</div>`;
}

function buildAPCSection(j: JournalInfo, theme: ThemeColors): string {
  if (!j.apcFee) return "";

  const cnyEstimate = Math.round(j.apcFee * 7.2);

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("版面费", theme)}
  <div style="padding:16px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
    <p style="margin:0;line-height:1.8;">
      《${esc(j.nameEn || j.name)}》需支付版面费 <strong>$${j.apcFee.toLocaleString()}</strong>（约合人民币 <strong>${cnyEstimate.toLocaleString()}</strong> 元）。
      作为开放获取期刊，读者可免费访问所有文章，有利于研究成果的广泛传播和引用。
    </p>
  </div>
</div>`;
}

function buildReviewCycleSection(j: JournalInfo, theme: ThemeColors): string {
  if (!j.reviewCycle) return "";

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("审稿周期", theme)}
  <div style="padding:16px;background:${theme.primaryBg};border-radius:8px;border-left:4px solid ${theme.accent};">
    <p style="margin:0;line-height:1.8;">
      《${esc(j.nameEn || j.name)}》审稿周期：<strong style="color:${theme.accent};">${esc(j.reviewCycle)}</strong>。
    </p>
  </div>
</div>`;
}

function buildSelfCitationSection(j: JournalInfo): string {
  if (j.selfCitationRate == null) return "";

  const rate = j.selfCitationRate;
  const safe = rate < 20;

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("自引率", undefined)}
  <div style="padding:16px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
    <p style="margin:0;">
      ${esc(j.nameEn || j.name)} 自引率为 <strong>${rate.toFixed(1)}%</strong>，
      ${safe ? `处于安全范围，可放心投稿。` : `偏高，投稿时需关注。`}
    </p>
  </div>
</div>`;
}

function buildWarningSection(j: JournalInfo): string {
  if (j.isWarningList) {
    return `
<div style="margin-bottom:24px;">
  ${sectionTitle("预警名单", undefined)}
  <div style="padding:16px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
    <p style="margin:0;color:#dc2626;font-weight:bold;">
      ⚠️ 该期刊在中科院《国际期刊预警名单》中${j.warningYear ? `（${esc(j.warningYear)} 版）` : ""}，投稿需谨慎评估。
    </p>
  </div>
</div>`;
  }

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("预警名单", undefined)}
  <div style="padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
    <p style="margin:0;color:#16a34a;">
      ✅ 中科院《国际期刊预警名单》：<strong>不在预警名单中</strong>，可放心投稿。
    </p>
  </div>
</div>`;
}

function buildRecommendationSection(j: JournalInfo, ai: AIGeneratedContent, theme: ThemeColors): string {
  const rating = ai.rating || 4;
  const fullStar = "★";
  const emptyStar = "☆";
  const stars = fullStar.repeat(rating) + emptyStar.repeat(5 - rating);

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("推荐指数", theme)}
  <div style="padding:20px;background:#fff;border-radius:12px;border:2px solid ${theme.primaryBorder};box-shadow:0 2px 8px rgba(0,0,0,0.04);">
    <p style="font-size:28px;margin:0 0 12px;text-align:center;letter-spacing:6px;">
      <span style="color:${theme.accent};">${stars}</span>
    </p>
    <div style="font-size:15px;line-height:2;color:#333;padding:0 4px;">
      ${ai.recommendation || ""}
    </div>
  </div>
</div>`;
}

// ============ 阅读节奏增强组件 ============

/**
 * 小编点评框 — 口语化、亲和力、打破严肃的学术感
 * 视觉：左侧装饰色条 + 对话气泡风格
 */
function buildEditorComment(comment: string, theme: ThemeColors): string {
  return `
<div style="margin:4px 0 24px;padding:14px 18px 14px 22px;background:${theme.primaryBg};border-left:4px solid ${theme.accent};border-radius:0 10px 10px 0;position:relative;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
    <span style="display:inline-block;width:22px;height:22px;background:${theme.accent};border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;">编</span>
    <span style="font-size:13px;font-weight:bold;color:${theme.primary};">小编说</span>
  </div>
  <p style="margin:0;font-size:14px;color:#555;line-height:1.8;font-style:italic;">"${esc(comment)}"</p>
</div>`;
}

/**
 * 划重点高亮框 — 提炼核心信息、增加视觉锚点
 * 视觉：虚线边框 + 图标 + 加粗文字
 */
function buildHighlightBox(tip: string, theme: ThemeColors): string {
  return `
<div style="margin:4px 0 24px;padding:16px 20px;background:${theme.primaryBg};border:2px dashed ${theme.primaryLight};border-radius:10px;text-align:center;">
  <p style="margin:0;font-size:15px;color:${theme.primary};font-weight:bold;line-height:1.8;">
    <span style="font-size:18px;margin-right:6px;">📌</span>划重点：${esc(tip)}
  </p>
</div>`;
}

/**
 * 装饰分割线 — 在章节之间增加呼吸感
 * 视觉：渐变透明 + 中间圆点装饰
 */
function buildDecorativeDivider(theme: ThemeColors): string {
  return `
<div style="text-align:center;margin:8px 0 20px;position:relative;">
  <div style="height:1px;background:linear-gradient(90deg,transparent 0%,${theme.primaryLight} 30%,${theme.primaryLight} 70%,transparent 100%);"></div>
  <div style="display:inline-block;background:#fff;padding:0 12px;position:relative;top:-6px;">
    <span style="color:${theme.primaryLight};font-size:10px;letter-spacing:6px;">● ● ●</span>
  </div>
</div>`;
}

/**
 * 底部钩子卡片 — 白底红色调，干净专业
 *
 * 结构：红色标题栏 + 白底内容区（服务标签 + 微信号 + 二维码）+ 红色底部强调条
 * qrCodeUrl: 二维码图片 URL，部署时替换为真实二维码地址
 */
function buildFooter(qrCodeUrl?: string, theme?: ThemeColors): string {
  const mainColor = theme?.primary || "#c41e3a";
  const mainBg = theme?.primaryBg || "#fef2f2";
  const mainBorder = theme?.primaryBorder || "#fecaca";
  // 服务标签：按类别分色
  const sciTags = ["SCI", "SSCI", "AHCI", "Scopus", "CPCI", "EI源刊"];
  const midTags = ["EI会议", "英文普刊"];
  const cnTags = ["著作", "核心", "专利"];
  const otherTags = ["国内普刊"];

  function tag(text: string, bg: string, border: string, color: string): string {
    return `<span style="display:inline-block;padding:5px 12px;background:${bg};border:1px solid ${border};border-radius:20px;font-size:12px;color:${color};font-weight:600;">${esc(text)}</span>`;
  }

  const tagHtml = [
    ...sciTags.map((t) => tag(t, mainBg, mainBorder, mainColor)),
    ...midTags.map((t) => tag(t, "#fff7ed", "#fed7aa", "#c2410c")),
    ...cnTags.map((t) => tag(t, "#f0fdf4", "#bbf7d0", "#16a34a")),
    ...otherTags.map((t) => tag(t, "#eff6ff", "#bfdbfe", "#2563eb")),
  ].join("\n        ");

  // 二维码区域
  const effectiveQr = qrCodeUrl || WECHAT_QR_BASE64;
  const qrHtml = `<div style="padding:6px;background:#fff;border:2px solid ${mainBorder};border-radius:10px;">
          <img src="${esc(effectiveQr)}" alt="微信二维码" style="width:90px;height:90px;display:block;border-radius:4px;" />
        </div>`;

  return `
<div style="text-align:center;padding:16px 0 20px;margin-top:8px;">
  <div style="width:60px;height:2px;background:${mainColor};margin:0 auto 14px;border-radius:1px;"></div>
  <p style="font-size:12px;color:#999;margin:0;">以上分析仅供参考，数据来源：LetPub、Springer Nature、PubMed</p>
</div>

<div style="border-radius:16px;overflow:hidden;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.12);">
  <div style="background:${mainColor};padding:18px 24px;text-align:center;">
    <h2 style="font-size:20px;color:#fff;margin:0;font-weight:800;letter-spacing:3px;">一站式科研服务 · 更快录用</h2>
  </div>

  <div style="background:#fff;padding:20px 24px;">
    <div style="text-align:center;margin-bottom:18px;">
      <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;">
        ${tagHtml}
      </div>
    </div>

    <div style="height:1px;background:linear-gradient(90deg,transparent,#e5e7eb,transparent);margin:0 20px 18px;"></div>

    <div style="display:flex;align-items:center;gap:20px;">
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
          <span style="font-size:13px;color:#666;">精准选刊</span>
          <span style="color:#ddd;">·</span>
          <span style="font-size:13px;color:#666;">正刊投稿</span>
          <span style="color:#ddd;">·</span>
          <span style="font-size:13px;color:#666;">全程指导</span>
        </div>
        <div style="background:${mainBg};border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:13px;color:#666;">微信咨询</span>
          <span style="font-size:18px;font-weight:800;color:${mainColor};letter-spacing:1px;">Wlfj2020</span>
        </div>
        <p style="font-size:11px;color:#bbb;margin:8px 0 0;">专业团队 · 安全可靠 · 渠道高效</p>
      </div>

      <div style="flex-shrink:0;text-align:center;">
        ${qrHtml}
        <p style="font-size:10px;color:#999;margin:6px 0 0;">扫码添加微信</p>
      </div>
    </div>
  </div>

  <div style="background:${mainColor};padding:8px 24px;text-align:center;">
    <span style="font-size:12px;color:rgba(255,255,255,0.85);letter-spacing:2px;">包 录 用 · 精 准 投 刊 发 表</span>
  </div>
</div>

<div style="text-align:center;padding:8px 0;">
  <p style="font-size:11px;color:#bbb;margin:0;">顺仕美途科研服务平台 · BossMate AI</p>
</div>`;
}

// ============ 工具函数 ============

function sectionTitle(title: string, theme?: ThemeColors): string {
  const t = theme || THEMES.medical;
  return `<h3 style="font-size:18px;color:${t.primary};margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid ${t.primaryLight};font-weight:bold;text-align:center;">${esc(title)}</h3>`;
}

function infoRow(label: string, value: string): string {
  return `<tr>
        <td style="padding:10px 14px;font-weight:bold;color:#64748b;white-space:nowrap;border-bottom:1px solid #f1f5f9;width:90px;font-size:13px;">${esc(label)}</td>
        <td style="padding:10px 14px;color:#1e293b;border-bottom:1px solid #f1f5f9;font-size:14px;">${value}</td>
      </tr>`;
}

function getIfColor(impactFactor: number | null): string {
  if (impactFactor == null) return "#6b7280";
  if (impactFactor >= 20) return "#dc2626";
  if (impactFactor >= 10) return "#ea580c";
  if (impactFactor >= 5) return "#059669";
  return "#2563eb";
}

function getPartitionColor(partition: string): string {
  if (partition.includes("Q1") || partition.includes("1区")) return "#dc2626";
  if (partition.includes("Q2") || partition.includes("2区")) return "#ea580c";
  if (partition.includes("Q3") || partition.includes("3区")) return "#ca8a04";
  return "#6b7280";
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
