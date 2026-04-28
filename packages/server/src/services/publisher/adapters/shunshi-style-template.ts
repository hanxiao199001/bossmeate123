/**
 * 顺仕美途风格期刊推荐模板（A 补丁：23 区块版本）
 *
 * 视觉对齐参考：顺仕美途科研服务平台 公众号 截图（用户提供 4 张原图）。
 * 风格定位：标准期刊推荐排版，23 区块结构 + 数据可视化 + 红蓝白配色，权威感最强。
 *
 * 配色 / 字号契约：
 *  - 红色 #DC143C / #E60012  →  期刊名 / 关键徽章
 *  - 蓝色 #1976D2 / #1E90FF  →  章节标题 / 链接
 *  - 白底 + 黑色正文 #333    →  正文
 *  - 章节标题 18px / 期刊名 18px / 红色小标题 16px / 正文 14px / line-height 1.7
 *
 * 23 区块（按渲染顺序）：
 *   1. Hero 首图（封面 + 期刊名 + IF 大字徽章）
 *   2. 期刊基本信息卡（ISSN / Publisher / 创刊年 / 国别 / 官网）
 *   3. JCR 分区徽章（Q1/Q2/Q3/Q4）
 *   4. IF 历史折线图 🆕  (P1 占位)
 *   5. IF 最新值（大字 + 同比变化 if_history 推算）🔄
 *   6. CAR 历史 🆕  (P1 占位)
 *   7. JCR 详细面板（jcr_full）🆕  (P3 隐藏整段 / P2 灰阶子字段)
 *   8. 收稿范围详细 🆕  (P1 占位)
 *   9. 版面费详细 🆕  (P2 灰阶)
 *  10. 出版周期 🔄  (P2 灰阶)
 *  11. 年发文量柱状图 🆕  (P1 占位)
 *  12. TOP 发文机构 🆕  (P3 隐藏)
 *  13. 引用前 10 期刊饼图 🆕  (P1 占位)
 *  14. 自引率徽章 🆕  (P3 隐藏)
 *  15. 推荐指数（1-5 星）🆕  (P2 灰阶)
 *  16. 综合点评（aiContent.recommendation 摘要）
 *  17. 投稿建议 / 难度评级（journal 派生）
 *  18. 优势（journal + AI 派生 bullet）
 *  19. 注意事项（journal + AI 派生 bullet）
 *  20. 营销文案 CTA
 *  21. 联系方式 / 二维码占位
 *  22. 免责声明
 *  23. Footer（版权 + 数据更新时间）
 *
 * 空值降级 3 档：
 *  - P1 占位：renderP1Placeholder(...) 醒目卡片，B.2 数据回填后自动替换
 *  - P2 灰阶：缺字段渲染 "暂无" / 灰文本，区块仍显示
 *  - P3 隐藏：整段 <section> 不输出
 *
 * 字段来源：B.1 + B.1.1 已落 schema 的 8 个 jsonb/integer 字段
 *  - if_history / car_index_history / publication_stats / jcr_full
 *  - citing_journals_top10 / recommendation_score / scope_details / publication_costs
 * JournalInfo 接口尚未扩展（spec 第 5.1 节硬约束：唯一改 1 文件），通过 (journal as any) 读取
 * + type guard 校验。NULL 或格式不符 → 走 P1/P2/P3 三档之一。
 *
 * 与 'data-card' / 'storytelling' / 'listicle' 互换性：签名完全一致。
 * WeChat 兼容性约束：inline style only / table 布局 / ≥14px / 不用 flex/grid。
 */

import type { JournalInfo, CollectionResult } from "../../data-collection/journal-content-collector.js";
import type { AIGeneratedContent } from "../../skills/journal-template.js";
import { esc } from "../../skills/journal-template.js";

type Abstracts = CollectionResult["abstracts"];

// ============ 配色 ============
const RED = "#DC143C";
const BLUE = "#1976D2";
const TEXT = "#333";
const MUTED = "#999";
const PLACEHOLDER_BG = "linear-gradient(135deg,#E3F2FD,#F5FAFF)";
const PLACEHOLDER_BORDER = "#90CAF9";

// ============ B 阶段 jsonb 字段类型 + type guard ============

interface IfHistoryShape {
  data: Array<{ year: number; if?: number; value?: number }>;
  predicted?: { year: number; if?: number; value?: number; source?: string };
  lastUpdatedAt?: string;
}
function isIfHistory(v: unknown): v is IfHistoryShape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.data);
}

interface CarIndexHistoryShape {
  data: Array<{ year: number; carIndex: number }>;
  riskLevel?: "low" | "mid" | "high";
  lastUpdatedAt?: string;
}
function isCarIndexHistory(v: unknown): v is CarIndexHistoryShape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.data);
}

interface PublicationStatsShape {
  frequency?: string;
  annualVolumeHistory?: Array<{ year: number; count: number }>;
  topInstitutions?: Array<{ name: string; paperCount?: number; count?: number; percentile?: number }>;
  lastUpdatedAt?: string;
}
function isPublicationStats(v: unknown): v is PublicationStatsShape {
  if (!v || typeof v !== "object") return false;
  return true; // 任一子字段缺都允许
}

interface JcrFullShape {
  wosLevel?: string;
  jifSubjects?: Array<{ subject: string; zone?: string; rank?: string; percentile?: number }> | string[];
  jciSubjects?: Array<{ subject: string; zone?: string; rank?: string; percentile?: number }> | string[];
  isTopJournal?: boolean;
  isReviewJournal?: boolean;
  lastUpdatedAt?: string;
}
function isJcrFull(v: unknown): v is JcrFullShape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.wosLevel != null || o.jifSubjects != null || o.jciSubjects != null ||
         o.isTopJournal != null || o.isReviewJournal != null;
}

interface CitingJournalsTop10Shape {
  topJournals: Array<{ name: string; percent?: number; count?: number }>;
  totalCitations?: number;
  lastUpdatedAt?: string;
}
function isCitingJournalsTop10(v: unknown): v is CitingJournalsTop10Shape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.topJournals);
}

interface ScopeDetailsShape {
  categories?: Array<{ title: string; description?: string }> | string[];
  articleTypes?: string[];
  submissionNote?: string;
  subjectDistribution?: Array<{ subject: string; percent: number }> | Record<string, number>;
  lastUpdatedAt?: string;
}
function isScopeDetails(v: unknown): v is ScopeDetailsShape {
  if (!v || typeof v !== "object") return false;
  return true;
}

interface PublicationCostsShape {
  apc?: number;
  apcFeeAmount?: number;
  currency?: string;
  apcFeeCurrency?: string;
  openAccess?: boolean;
  isHybrid?: boolean;
  fastTrack?: boolean;
  extras?: Array<{ name: string; amount?: number }>;
  apcFeeNote?: string;
  vatNote?: string;
  lastUpdatedAt?: string;
}
function isPublicationCosts(v: unknown): v is PublicationCostsShape {
  if (!v || typeof v !== "object") return false;
  return true;
}

// ============ 通用工具 ============

/** P1 占位卡（最显眼）：核心 selling point 缺数据时用 */
function renderP1Placeholder(opts: {
  title: string;
  icon: string;
  message: string;
  submessage?: string;
}): string {
  const sub = opts.submessage
    ? `<p style="margin:6px 0 0 0;font-size:12px;color:#5A7A99;line-height:1.6;">${esc(opts.submessage)}</p>`
    : "";
  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:16px;font-weight:bold;color:${RED};text-align:center;line-height:1.5;">${esc(opts.title)}</p>` +
    `<div style="border:2px dashed ${PLACEHOLDER_BORDER};padding:24px 16px;text-align:center;border-radius:8px;background:${PLACEHOLDER_BG};">` +
      `<p style="margin:0 0 6px 0;font-size:28px;line-height:1;">${esc(opts.icon)}</p>` +
      `<p style="margin:0;font-size:15px;font-weight:600;color:${BLUE};line-height:1.6;">${esc(opts.message)}</p>` +
      sub +
    `</div>` +
    `</section>`;
}

/** P2 灰阶 value：缺值显示"暂无" */
function greyOrValue(v: unknown, fallback = "暂无"): string {
  if (v == null || v === "" || (typeof v === "number" && Number.isNaN(v))) {
    return `<span style="color:${MUTED};">${esc(fallback)}</span>`;
  }
  return esc(String(v));
}

// ============ 区块 1: Hero 首图 ============
function renderHeroBlock(journal: JournalInfo): string {
  const fullName = esc(journal.nameEn || journal.name);
  const cnName = journal.nameEn && journal.name && journal.name !== journal.nameEn
    ? esc(journal.name) : "";
  const cover = journal.coverUrl || (journal as any).coverImageUrl;
  const ifBadge = journal.impactFactor != null
    ? `<div style="display:inline-block;padding:8px 16px;margin-top:12px;background:${RED};color:#fff;border-radius:8px;font-size:18px;font-weight:bold;line-height:1.3;">IF ${esc(String(journal.impactFactor))}</div>`
    : `<div style="display:inline-block;padding:8px 16px;margin-top:12px;background:#EEE;color:${MUTED};border-radius:8px;font-size:14px;font-weight:600;line-height:1.3;">IF 暂无</div>`;

  const coverHtml = cover
    ? `<img src="${esc(cover)}" alt="${fullName}" style="max-width:100%;height:auto;display:block;margin:0 auto 12px auto;border-radius:6px;" />`
    : "";

  return `<section style="margin:0 0 22px 0;text-align:center;">` +
    coverHtml +
    `<p style="margin:0;font-size:18px;font-weight:bold;color:${RED};line-height:1.5;">${fullName}</p>` +
    (cnName ? `<p style="margin:4px 0 0 0;font-size:14px;color:${TEXT};line-height:1.5;">${cnName}</p>` : "") +
    ifBadge +
    `</section>`;
}

// ============ 区块 2: 期刊基本信息卡 ============
function renderBasicInfoBlock(journal: JournalInfo): string {
  const lines: string[] = [
    `<strong>ISSN：</strong>${greyOrValue(journal.issn)}`,
    `<strong>Publisher：</strong>${greyOrValue(journal.publisher)}`,
    `<strong>创刊年：</strong>${greyOrValue(journal.foundingYear ? `${journal.foundingYear}` : null)}`,
    `<strong>出版国：</strong>${greyOrValue(journal.country)}`,
  ];
  if (journal.website) {
    const safe = esc(journal.website);
    lines.push(`<strong>官网：</strong><a href="${safe}" style="color:${BLUE};text-decoration:none;">${safe}</a>`);
  } else {
    lines.push(`<strong>官网：</strong>${greyOrValue(null)}`);
  }

  const ps = lines
    .map((l) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">${l}</p>`)
    .join("");

  return `<section style="margin:0 0 18px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
    ps +
    `</section>`;
}

// ============ 区块 3: JCR 分区徽章 ============
function renderJcrQuartileBlock(journal: JournalInfo): string {
  const q = journal.partition;
  const valid = typeof q === "string" && /^Q[1-4]$/i.test(q);
  const display = valid ? q!.toUpperCase() : "未分区";
  const bg = valid ? RED : "#BDBDBD";
  const tip = valid ? "JCR 分区" : "JCR 分区数据未公布";

  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<div style="display:inline-block;padding:10px 22px;background:${bg};color:#fff;border-radius:6px;font-size:18px;font-weight:bold;line-height:1.4;">${esc(display)}</div>` +
    `<p style="margin:6px 0 0 0;font-size:12px;color:${MUTED};line-height:1.6;">${esc(tip)}</p>` +
    `</section>`;
}

// ============ 区块 4: IF 历史折线图 ============
function renderIfHistoryChart(journal: JournalInfo): string {
  const raw = (journal as any).ifHistory;
  if (!isIfHistory(raw)) {
    return renderP1Placeholder({
      title: "近 10 年影响因子",
      icon: "📈",
      message: "数据采集中",
      submessage: "B.2 阶段批量回填后渲染折线图",
    });
  }
  const years = raw.data.length;
  return renderP1Placeholder({
    title: "近 10 年影响因子",
    icon: "📈",
    message: `已收集 ${years} 年数据`,
    submessage: "C 阶段渲染折线图（柱状图占位）",
  });
}

// ============ 区块 5: IF 最新值 + 同比变化 ============
function renderImpactFactorBlock(journal: JournalInfo): string {
  const if_ = journal.impactFactor;
  if (if_ == null) {
    return `<section style="margin:0 0 22px 0;text-align:center;">` +
      `<p style="margin:0 0 6px 0;font-size:14px;color:${TEXT};line-height:1.7;">最新影响因子</p>` +
      `<p style="margin:0;font-size:24px;font-weight:bold;color:${MUTED};line-height:1.3;">暂无</p>` +
      `</section>`;
  }

  // 同比：从 if_history 推算
  let yoy = "";
  const raw = (journal as any).ifHistory;
  if (isIfHistory(raw) && raw.data.length >= 2) {
    const sorted = [...raw.data].sort((a, b) => a.year - b.year);
    const latest = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    const latestVal = latest.if ?? latest.value;
    const prevVal = prev.if ?? prev.value;
    if (typeof latestVal === "number" && typeof prevVal === "number" && prevVal > 0) {
      const delta = ((latestVal - prevVal) / prevVal) * 100;
      const sign = delta >= 0 ? "▲" : "▼";
      const color = delta >= 0 ? "#388E3C" : "#D32F2F";
      yoy = `<p style="margin:6px 0 0 0;font-size:14px;color:${color};font-weight:600;line-height:1.5;">${sign} 同比 ${Math.abs(delta).toFixed(1)}%</p>`;
    }
  }

  return `<section style="margin:0 0 22px 0;text-align:center;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 6px 0;font-size:13px;color:${MUTED};line-height:1.6;">最新影响因子</p>` +
    `<p style="margin:0;font-size:32px;font-weight:bold;color:${RED};line-height:1.2;">${esc(String(if_))}</p>` +
    yoy +
    `</section>`;
}

// ============ 区块 6: CAR 指数历史 ============
function renderCarHistoryBlock(journal: JournalInfo): string {
  const raw = (journal as any).carIndexHistory;
  if (!isCarIndexHistory(raw)) {
    return renderP1Placeholder({
      title: "CAR 指数（被引活跃度）",
      icon: "🎯",
      message: "数据采集中",
      submessage: "CAR = Citation Activity Rank，B.2 阶段补真数据",
    });
  }
  const years = raw.data.length;
  const risk = raw.riskLevel
    ? (raw.riskLevel === "low" ? "低风险" : raw.riskLevel === "high" ? "高风险" : "中等风险")
    : "未评级";
  return renderP1Placeholder({
    title: "CAR 指数（被引活跃度）",
    icon: "🎯",
    message: `已收集 ${years} 年数据 · ${risk}`,
    submessage: "C 阶段渲染历史柱状图",
  });
}

// ============ 区块 7: JCR 详细面板（P3 隐藏 / P2 灰阶） ============
function renderJcrFullPanel(journal: JournalInfo): string {
  const raw = (journal as any).jcrFull;
  if (!isJcrFull(raw)) {
    return ""; // P3 隐藏
  }
  const rows: string[] = [];

  rows.push(jcrRow("WoS Level", raw.wosLevel));
  rows.push(jcrRow("JIF Subjects", formatJcrSubjects(raw.jifSubjects)));
  rows.push(jcrRow("JCI Subjects", formatJcrSubjects(raw.jciSubjects)));
  rows.push(jcrRow("Top Journal", typeof raw.isTopJournal === "boolean" ? (raw.isTopJournal ? "是" : "否") : null));
  rows.push(jcrRow("Review Journal", typeof raw.isReviewJournal === "boolean" ? (raw.isReviewJournal ? "是" : "否") : null));

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">JCR 详细</p>` +
    `<div style="padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
      rows.join("") +
    `</div>` +
    `</section>`;
}

function jcrRow(label: string, value: string | null | undefined): string {
  const isEmpty = value == null || value === "";
  const valHtml = isEmpty
    ? `<span style="color:${MUTED};">暂无</span>`
    : esc(String(value));
  return `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};"><strong>${esc(label)}：</strong>${valHtml}</p>`;
}

function formatJcrSubjects(subj: JcrFullShape["jifSubjects"] | JcrFullShape["jciSubjects"]): string | null {
  if (!Array.isArray(subj) || subj.length === 0) return null;
  if (typeof subj[0] === "string") {
    return (subj as string[]).join("、");
  }
  return (subj as Array<{ subject: string; zone?: string; rank?: string; percentile?: number }>)
    .map((s) => {
      const meta: string[] = [];
      if (s.zone) meta.push(s.zone);
      if (s.rank) meta.push(s.rank);
      if (typeof s.percentile === "number") meta.push(`${s.percentile}%`);
      return `${s.subject}${meta.length > 0 ? `（${meta.join(" · ")}）` : ""}`;
    })
    .join("、");
}

// ============ 区块 8: 收稿范围详细 ============
function renderScopeDetailsBlock(journal: JournalInfo): string {
  const raw = (journal as any).scopeDetails;
  if (!isScopeDetails(raw) || (!raw.categories && !raw.subjectDistribution && !raw.articleTypes)) {
    return renderP1Placeholder({
      title: "收稿范围与学科分布",
      icon: "🔬",
      message: "数据采集中",
      submessage: "B.2 阶段补 9 大领域 + 学科占比",
    });
  }

  const blocks: string[] = [];

  // 9 大领域
  if (Array.isArray(raw.categories) && raw.categories.length > 0) {
    const tags = raw.categories
      .map((c) => {
        const t = typeof c === "string" ? c : c.title;
        return `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;background:#E3F2FD;color:${BLUE};border-radius:4px;font-size:13px;line-height:1.6;">${esc(t)}</span>`;
      })
      .join("");
    blocks.push(`<div style="margin:0 0 10px 0;">${tags}</div>`);
  }

  // 文章类型
  if (Array.isArray(raw.articleTypes) && raw.articleTypes.length > 0) {
    blocks.push(`<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};"><strong>接收类型：</strong>${esc(raw.articleTypes.join("、"))}</p>`);
  }

  // 投稿提示
  if (raw.submissionNote) {
    blocks.push(`<p style="margin:0;font-size:13px;line-height:1.7;color:${MUTED};">${esc(raw.submissionNote)}</p>`);
  }

  if (blocks.length === 0) {
    return renderP1Placeholder({
      title: "收稿范围与学科分布",
      icon: "🔬",
      message: "数据采集中",
      submessage: "B.2 阶段补 9 大领域 + 学科占比",
    });
  }

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:16px;font-weight:bold;color:${RED};text-align:center;line-height:1.5;">收稿范围与学科分布</p>` +
    `<div style="padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
      blocks.join("") +
    `</div>` +
    `</section>`;
}

// ============ 区块 9: 版面费详细 ============
function renderPublicationCostsBlock(journal: JournalInfo): string {
  const raw = (journal as any).publicationCosts;
  const has = isPublicationCosts(raw);
  const costs: PublicationCostsShape = has ? raw : {};

  const apc = costs.apc ?? costs.apcFeeAmount;
  const currency = costs.currency ?? costs.apcFeeCurrency;
  const apcDisplay = typeof apc === "number"
    ? `${currency || "USD"} ${apc.toLocaleString("en-US")}`
    : null;

  const isOA = typeof costs.openAccess === "boolean" ? costs.openAccess : null;
  const isFast = typeof costs.fastTrack === "boolean" ? costs.fastTrack : null;

  const rows: string[] = [];
  rows.push(jcrRow("APC 版面费", apcDisplay));
  rows.push(jcrRow("是否 OA", isOA == null ? null : (isOA ? "是" : "否")));
  rows.push(jcrRow("Fast Track", isFast == null ? null : (isFast ? "支持" : "不支持")));

  // extras 附加费列表
  if (Array.isArray(costs.extras) && costs.extras.length > 0) {
    const extraText = costs.extras
      .map((e) => `${e.name}${typeof e.amount === "number" ? ` ${e.amount}` : ""}`)
      .join("、");
    rows.push(jcrRow("附加费", extraText));
  } else {
    rows.push(jcrRow("附加费", null));
  }

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">版面费</p>` +
    `<div style="padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
      rows.join("") +
    `</div>` +
    `</section>`;
}

// ============ 区块 10: 出版周期 ============
function renderFrequencyBlock(journal: JournalInfo): string {
  const raw = (journal as any).publicationStats;
  let freq: string | null | undefined = null;
  if (isPublicationStats(raw) && typeof raw.frequency === "string") {
    freq = raw.frequency;
  }
  if (!freq && journal.frequency) {
    freq = journal.frequency;
  }

  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.6;">出版周期</p>` +
    `<p style="margin:0;font-size:16px;font-weight:600;color:${TEXT};line-height:1.5;">${greyOrValue(freq, "未知")}</p>` +
    `</section>`;
}

// ============ 区块 11: 年发文量柱状图 ============
function renderAnnualVolumeChart(journal: JournalInfo): string {
  const raw = (journal as any).publicationStats;
  if (isPublicationStats(raw) && Array.isArray(raw.annualVolumeHistory) && raw.annualVolumeHistory.length > 0) {
    const years = raw.annualVolumeHistory.length;
    const total = raw.annualVolumeHistory.reduce((s, x) => s + (x.count || 0), 0);
    return renderP1Placeholder({
      title: "近 10 年发文量",
      icon: "📊",
      message: `已收集 ${years} 年数据，累计 ${total} 篇`,
      submessage: "C 阶段渲染柱状图",
    });
  }
  return renderP1Placeholder({
    title: "近 10 年发文量",
    icon: "📊",
    message: "数据采集中",
    submessage: "B.2 阶段批量回填后渲染柱状图",
  });
}

// ============ 区块 12: TOP 发文机构（P3 隐藏） ============
function renderTopInstitutionsBlock(journal: JournalInfo): string {
  const raw = (journal as any).publicationStats;
  if (!isPublicationStats(raw) || !Array.isArray(raw.topInstitutions) || raw.topInstitutions.length === 0) {
    return ""; // P3 隐藏
  }
  const top5 = raw.topInstitutions.slice(0, 5);
  const items = top5
    .map((inst, i) => {
      const cnt = inst.paperCount ?? inst.count;
      const cntText = typeof cnt === "number" ? ` <span style="color:${MUTED};">${cnt} 篇</span>` : "";
      return `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">` +
        `<span style="display:inline-block;min-width:22px;color:${BLUE};font-weight:bold;">${i + 1}.</span>` +
        `${esc(inst.name)}${cntText}` +
        `</p>`;
    })
    .join("");

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:16px;font-weight:bold;color:${RED};text-align:center;line-height:1.5;">国内 TOP 5 发文机构</p>` +
    `<div style="padding:12px 16px;background:#FAFAFA;border-radius:6px;">${items}</div>` +
    `</section>`;
}

// ============ 区块 13: 引用前 10 期刊饼图 ============
function renderCitingJournalsPie(journal: JournalInfo): string {
  const raw = (journal as any).citingJournalsTop10;
  if (!isCitingJournalsTop10(raw) || raw.topJournals.length === 0) {
    return renderP1Placeholder({
      title: "引用前 10 种期刊",
      icon: "🥧",
      message: "数据采集中",
      submessage: "B.2 阶段补 Top 10 + 占比，C 阶段渲染饼图",
    });
  }
  const n = raw.topJournals.length;
  return renderP1Placeholder({
    title: "引用前 10 种期刊",
    icon: "🥧",
    message: `已收集 ${n} 种引用源`,
    submessage: "C 阶段渲染饼图",
  });
}

// ============ 区块 14: 自引率徽章（P3 隐藏） ============
function renderSelfCitationBadge(journal: JournalInfo): string {
  const raw = (journal as any).citingJournalsTop10;
  if (!isCitingJournalsTop10(raw) || raw.topJournals.length === 0) {
    return ""; // P3 隐藏（无引用数据）
  }
  // 推算自引率：topJournals 里是否含本刊
  const selfName = (journal.nameEn || journal.name || "").toLowerCase();
  const selfEntry = raw.topJournals.find((j) =>
    j.name && j.name.toLowerCase().includes(selfName) && selfName.length >= 4
  );
  const selfPercent = selfEntry?.percent;
  if (typeof selfPercent !== "number") {
    return ""; // 没找到自身或无 percent
  }
  const risk = selfPercent < 10 ? "低" : selfPercent < 20 ? "中" : "高";
  const color = selfPercent < 10 ? "#388E3C" : selfPercent < 20 ? "#F57C00" : "#D32F2F";
  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.6;">自引率</p>` +
    `<p style="margin:0;font-size:20px;font-weight:bold;color:${color};line-height:1.4;">${selfPercent.toFixed(1)}% · ${risk}风险</p>` +
    `</section>`;
}

// ============ 区块 15: 推荐指数（1-5 星） ============
function renderRecommendationScoreBlock(journal: JournalInfo): string {
  const score = (journal as any).recommendationScore;
  const valid = typeof score === "number" && score >= 1 && score <= 5;

  if (!valid) {
    return `<section style="margin:0 0 18px 0;text-align:center;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
      `<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.6;">推荐指数</p>` +
      `<p style="margin:0;font-size:14px;color:${MUTED};line-height:1.6;">待评估</p>` +
      `</section>`;
  }
  const stars = "★".repeat(score) + "☆".repeat(5 - score);
  return `<section style="margin:0 0 18px 0;text-align:center;padding:14px 16px;background:#FFF8E1;border-radius:6px;">` +
    `<p style="margin:0 0 6px 0;font-size:13px;color:${MUTED};line-height:1.6;">推荐指数</p>` +
    `<p style="margin:0;font-size:24px;color:#F9A825;letter-spacing:4px;line-height:1.2;">${stars}</p>` +
    `<p style="margin:6px 0 0 0;font-size:14px;font-weight:600;color:${TEXT};line-height:1.5;">${score} / 5</p>` +
    `</section>`;
}

// ============ 区块 16: 综合点评（aiContent.recommendation 摘要） ============
function renderSummaryBlock(aiContent: AIGeneratedContent): string {
  const reco = aiContent.recommendation
    ? aiContent.recommendation.replace(/\s+/g, " ").trim()
    : "";
  if (!reco) {
    return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
      `<p style="margin:0 0 6px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">综合点评</p>` +
      `<p style="margin:0;font-size:14px;color:${MUTED};line-height:1.7;">待 AI 生成</p>` +
      `</section>`;
  }
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">综合点评</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.8;color:${TEXT};">${esc(reco)}</p>` +
    `</section>`;
}

// ============ 区块 17: 投稿建议 / 难度评级 ============
function renderSubmissionAdviceBlock(journal: JournalInfo): string {
  const ar = journal.acceptanceRate;
  const rc = journal.reviewCycle;

  let difficulty = "难度待评估";
  let color = MUTED;
  if (ar != null) {
    if (ar >= 0.45) { difficulty = "录用率较高，相对友好"; color = "#388E3C"; }
    else if (ar >= 0.25) { difficulty = "录用率中等，准备充分可冲"; color = "#F57C00"; }
    else { difficulty = "录用率较低，需高质量稿件"; color = "#D32F2F"; }
  }

  const arDisplay = ar != null ? `${(ar * 100).toFixed(0)}%` : null;
  const rcDisplay = rc || null;

  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">投稿建议</p>` +
    `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${color};font-weight:600;">${esc(difficulty)}</p>` +
    `<p style="margin:0 0 4px 0;font-size:14px;line-height:1.7;color:${TEXT};"><strong>录用率：</strong>${greyOrValue(arDisplay)}</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.7;color:${TEXT};"><strong>审稿周期：</strong>${greyOrValue(rcDisplay)}</p>` +
    `</section>`;
}

// ============ 优势 / 注意事项 派生（沿用 listicle 思路） ============
function deriveAdvantages(journal: JournalInfo, aiContent: AIGeneratedContent): string[] {
  const items: string[] = [];

  if (typeof journal.impactFactor === "number" && journal.impactFactor >= 5) {
    items.push(`影响因子 ${journal.impactFactor}，学界影响力高`);
  }
  if (typeof journal.acceptanceRate === "number" && journal.acceptanceRate >= 0.4) {
    items.push(`录用率约 ${(journal.acceptanceRate * 100).toFixed(0)}%，相对友好`);
  }
  if (journal.casPartition === "1" || journal.partition === "Q1") {
    items.push(`Q1 / 1 区，评审认可度高`);
  }
  if (journal.casPartitionNew && /top/i.test(journal.casPartitionNew)) {
    items.push(`新锐分区 TOP 期刊，被引活跃`);
  }
  if (journal.reviewCycle && /(2|3|4).*月|6.*周|fast/i.test(journal.reviewCycle)) {
    items.push(`审稿周期 ${journal.reviewCycle}，进度可控`);
  }
  if ((journal as any).publicationCosts?.openAccess === true) {
    items.push("开放获取（OA），引用可见度高");
  }
  if ((journal as any).jcrFull?.isTopJournal === true) {
    items.push("JCR Top 期刊标记，权威认可");
  }

  // AI recommendation 切句补强（剔除 HTML/Markdown 字面量）
  if (aiContent.recommendation && items.length < 5) {
    const stripped = aiContent.recommendation
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1");
    const sentences = stripped.split(/[。；;\n]+/).map((s) => s.trim());
    for (const s of sentences) {
      if (s.length >= 8 && s.length <= 80 && /快|稳|广|高|友好|易|优|适合|推荐|质量|权威/.test(s)) {
        if (!items.includes(s)) items.push(s);
        if (items.length >= 5) break;
      }
    }
  }

  return items.slice(0, 5);
}

function deriveCautions(journal: JournalInfo, aiContent: AIGeneratedContent): string[] {
  const items: string[] = [];

  if (typeof journal.acceptanceRate === "number" && journal.acceptanceRate < 0.25) {
    items.push(`录用率仅 ${(journal.acceptanceRate * 100).toFixed(0)}%，需准备充分稿件`);
  }
  const apc = (journal as any).publicationCosts?.apc ?? (journal as any).publicationCosts?.apcFeeAmount ?? journal.apcFee;
  if (typeof apc === "number" && apc >= 2000) {
    const cur = (journal as any).publicationCosts?.currency ?? (journal as any).publicationCosts?.apcFeeCurrency ?? "USD";
    items.push(`APC 版面费约 ${cur} ${apc}，注意预算`);
  }
  if (typeof journal.selfCitationRate === "number" && journal.selfCitationRate > 0.2) {
    items.push("自引率偏高，引用本刊文献时酌情把控");
  }
  if (journal.isWarningList) {
    items.push(`已被列入预警名单（${journal.warningYear || "近期"}），慎重投稿`);
  }
  if (aiContent.recommendation && items.length < 3) {
    const stripped = aiContent.recommendation.replace(/<\/?[a-zA-Z][^>]*>/g, "");
    const sentences = stripped.split(/[。；;\n]+/).map((s) => s.trim());
    for (const s of sentences) {
      if (s.length >= 8 && s.length <= 80 && /慢|长|低|严|拒|高费|APC|风险|注意|避免|警惕/.test(s)) {
        if (!items.includes(s)) items.push(s);
        if (items.length >= 3) break;
      }
    }
  }

  return items.slice(0, 3);
}

// ============ 区块 18: 优势 ============
function renderAdvantagesBlock(journal: JournalInfo, aiContent: AIGeneratedContent): string {
  const items = deriveAdvantages(journal, aiContent);
  if (items.length === 0) {
    return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
      `<p style="margin:0 0 6px 0;font-size:16px;font-weight:bold;color:#388E3C;line-height:1.5;">✅ 优势</p>` +
      `<p style="margin:0;font-size:14px;color:${MUTED};line-height:1.7;">暂无</p>` +
      `</section>`;
  }
  const lis = items
    .map((s) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">· ${esc(s)}</p>`)
    .join("");
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#F1F8E9;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:#388E3C;line-height:1.5;">✅ 优势</p>` +
    lis +
    `</section>`;
}

// ============ 区块 19: 注意事项 ============
function renderCautionsBlock(journal: JournalInfo, aiContent: AIGeneratedContent): string {
  const items = deriveCautions(journal, aiContent);
  if (items.length === 0) {
    return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
      `<p style="margin:0 0 6px 0;font-size:16px;font-weight:bold;color:#F57C00;line-height:1.5;">⚠️ 注意事项</p>` +
      `<p style="margin:0;font-size:14px;color:${MUTED};line-height:1.7;">暂无</p>` +
      `</section>`;
  }
  const lis = items
    .map((s) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">· ${esc(s)}</p>`)
    .join("");
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FFF8E1;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:#F57C00;line-height:1.5;">⚠️ 注意事项</p>` +
    lis +
    `</section>`;
}

// ============ 区块 20: 营销文案 CTA ============
function renderMarketingCtaBlock(journal: JournalInfo): string {
  const journalName = esc(journal.nameEn || journal.name);
  return `<section style="margin:0 0 22px 0;padding:16px 18px;background:linear-gradient(135deg,#1976D2,#42A5F5);border-radius:8px;text-align:center;">` +
    `<p style="margin:0 0 6px 0;font-size:16px;font-weight:bold;color:#fff;line-height:1.5;">需要投稿协助？</p>` +
    `<p style="margin:0;font-size:14px;color:#E3F2FD;line-height:1.7;">${journalName} 投稿格式审核 / 选题契合度评估 / 同行案例查询，扫码联系小助手</p>` +
    `</section>`;
}

// ============ 区块 21: 联系方式 / 二维码 ============
function renderContactBlock(): string {
  return `<section style="margin:0 0 18px 0;text-align:center;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 4px 0;font-size:14px;color:${TEXT};font-weight:600;line-height:1.6;">联系方式</p>` +
    `<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.7;">详见公众号底部二维码 · 工作日 9:00-18:00 答疑</p>` +
    `</section>`;
}

// ============ 区块 22: 免责声明 ============
function renderDisclaimerBlock(): string {
  return `<section style="margin:0 0 14px 0;padding:10px 14px;background:#F5F5F5;border-radius:4px;">` +
    `<p style="margin:0;font-size:12px;color:${MUTED};line-height:1.7;">免责声明：本文数据来源于公开渠道（LetPub / WoS / Springer / 期刊官网等），仅供学术参考。最终投稿决策请以期刊官网最新公告为准。</p>` +
    `</section>`;
}

// ============ 区块 23: Footer ============
function renderFooterBlock(journal: JournalInfo): string {
  // 数据更新时间：取所有 lastUpdatedAt 最新值；否则当前日期
  const candidates: string[] = [];
  for (const k of ["ifHistory", "carIndexHistory", "publicationStats", "jcrFull",
                   "citingJournalsTop10", "scopeDetails", "publicationCosts"]) {
    const v = (journal as any)[k];
    if (v && typeof v === "object" && typeof v.lastUpdatedAt === "string") {
      candidates.push(v.lastUpdatedAt);
    }
  }
  const updatedAt = candidates.length > 0
    ? candidates.sort().pop()
    : new Date().toISOString().slice(0, 10);

  return `<section style="margin:0;padding:10px 14px;text-align:center;">` +
    `<p style="margin:0;font-size:11px;color:${MUTED};line-height:1.6;">数据更新：${esc(updatedAt as string)} · BossMate 期刊推荐</p>` +
    `</section>`;
}

// ============ 主入口 ============

export async function generateShunshiStyleHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  _abstracts?: Abstracts
): Promise<string> {
  const sections: string[] = [];

  sections.push(renderHeroBlock(journal));                            //  1
  sections.push(renderBasicInfoBlock(journal));                       //  2
  sections.push(renderJcrQuartileBlock(journal));                     //  3
  sections.push(renderIfHistoryChart(journal));                       //  4 🆕
  sections.push(renderImpactFactorBlock(journal));                    //  5 🔄
  sections.push(renderCarHistoryBlock(journal));                      //  6 🆕
  sections.push(renderJcrFullPanel(journal));                         //  7 🆕 (P3)
  sections.push(renderScopeDetailsBlock(journal));                    //  8 🆕
  sections.push(renderPublicationCostsBlock(journal));                //  9 🆕
  sections.push(renderFrequencyBlock(journal));                       // 10 🔄
  sections.push(renderAnnualVolumeChart(journal));                    // 11 🆕
  sections.push(renderTopInstitutionsBlock(journal));                 // 12 🆕 (P3)
  sections.push(renderCitingJournalsPie(journal));                    // 13 🆕
  sections.push(renderSelfCitationBadge(journal));                    // 14 🆕 (P3)
  sections.push(renderRecommendationScoreBlock(journal));             // 15 🆕
  sections.push(renderSummaryBlock(aiContent));                       // 16
  sections.push(renderSubmissionAdviceBlock(journal));                // 17
  sections.push(renderAdvantagesBlock(journal, aiContent));           // 18
  sections.push(renderCautionsBlock(journal, aiContent));             // 19
  sections.push(renderMarketingCtaBlock(journal));                    // 20
  sections.push(renderContactBlock());                                // 21
  sections.push(renderDisclaimerBlock());                             // 22
  sections.push(renderFooterBlock(journal));                          // 23

  return sections.filter((s) => s.length > 0).join("\n");
}
