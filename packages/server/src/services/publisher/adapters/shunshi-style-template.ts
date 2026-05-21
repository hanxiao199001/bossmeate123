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
import {
  renderIfHistoryLineChart,
  renderAnnualVolumeBarChart,
  renderCarHistoryLineChart,
  renderCitingPieChart,
  // PR Q.6 D5
  renderAcceptRateBarChart,
  renderFeePieChart,
  renderSubjectDistributionChart,
  renderReviewCycleBarChart,
} from "../svg-charts/index.js";

type Abstracts = CollectionResult["abstracts"];

// ============ 配色（PR Q.7.2：palette 占位，generateShunshiStyleHtml 末尾 replaceAll 注入实色）============
// 4 套模板 palette.primary/.accent 不同；BLUE/RED 现为占位字符串，运行时根据 selected
// template 的 cssTheme.palette 真值替换，让 4 套主色调真差异化（user 5-7 D4 验收发现）。
// 语义色（推荐绿 #388E3C / 警告红 #D32F2F / 注意橙 #F57C00 / 异常红 #C62828）保留不变。
const RED = "{{ACCENT}}";
const BLUE = "{{PRIMARY}}";
const TEXT = "#333";
const MUTED = "#999";
const PLACEHOLDER_BG = "linear-gradient(135deg,{{PRIMARY_BG}},#F5FAFF)";
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

/**
 * 租户级联系信息（task #35）。来自 tenants.contact_meta jsonb。
 * admin UI 5-13 后由老板自维护；本 PR 用 migration seed 写一个 BossMate 默认 placeholder。
 */
export interface ContactMeta {
  contactName: string;
  wechatId?: string;
  workingHours?: string;
  qrCodeUrl?: string;
  email?: string;
  phone?: string;
  lastUpdatedAt?: string;
}
/**
 * TenantInfo（minimal）：只取区块 21 需要的字段，避免污染 JournalInfo / 跨层耦合。
 * contactMeta 用 unknown — 来自 jsonb，运行时由 isContactMeta type guard 校验。
 */
export interface TenantInfo {
  contactMeta?: unknown;
}
function isContactMeta(v: unknown): v is ContactMeta {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.contactName === "string" && o.contactName.trim().length > 0;
}

// ============ 通用工具 ============

/** P1 占位卡（最显眼）：核心 selling point 缺数据时用.
 *
 * PR #136 (5-12 demo blocker 余漏): chart 数据 NULL 时整 section 不渲染,
 * 不再显示"数据采集中/数据完善中/敬请期待"假数据感占位. 8 callers (IF/CAR/发文/引用/JCR 等) 全自动 skip.
 * 旧 P1 placeholder 在 backlog: V2.6 用 dataset 真填充时去掉, 不再 fallback HTML.
 *
 * Args 保留兼容 callers (无破坏改动), 但 return 永空字符串.
 */
function renderP1Placeholder(_opts: {
  title: string;
  icon: string;
  message: string;
  submessage?: string;
}): string {
  return "";
}

/** P2 灰阶 value：缺值显示"未公开"（PR #135 5-12: 原"暂无"被 user 反馈像假数据） */
function greyOrValue(v: unknown, fallback = "未公开"): string {
  if (v == null || v === "" || (typeof v === "number" && Number.isNaN(v))) {
    return `<span style="color:${MUTED};">${esc(fallback)}</span>`;
  }
  return esc(String(v));
}

// PR #191 (5-20): 学科主题题图 — 封面真图补不全 (LetPub无/Springer仅14%), 改学科配图库.
// 按 discipline 给配色渐变 + emoji 大图标, 100% 覆盖 + 好看, 公众号 HTML 原生支持.
function disciplineTheme(discipline: string | null | undefined): { grad: string; icon: string } {
  const d = (discipline || "").toLowerCase();
  if (/医|临床|药|medic|clinic|pharma|health/.test(d)) return { grad: "#E53935,#FF8A65", icon: "\u{1FA7A}" };
  if (/生物|biolog|genetic|cell|分子/.test(d)) return { grad: "#43A047,#A5D6A7", icon: "\u{1F9EC}" };
  if (/化学|chemi/.test(d)) return { grad: "#8E24AA,#CE93D8", icon: "\u2697\uFE0F" };
  if (/物理|physic/.test(d)) return { grad: "#1E88E5,#90CAF9", icon: "\u269B\uFE0F" };
  if (/材料|material/.test(d)) return { grad: "#FB8C00,#FFCC80", icon: "\u{1F52C}" };
  if (/工程|工科|engineer|机械|电/.test(d)) return { grad: "#3949AB,#9FA8DA", icon: "\u2699\uFE0F" };
  if (/计算|信息|软件|comput|software|data|人工智能|ai/.test(d)) return { grad: "#00897B,#80CBC4", icon: "\u{1F4BB}" };
  if (/能源|energy|电力/.test(d)) return { grad: "#F9A825,#FFE082", icon: "\u26A1" };
  if (/环境|生态|environ|ecolog|climate/.test(d)) return { grad: "#2E7D32,#A5D6A7", icon: "\u{1F33F}" };
  if (/经济|管理|金融|商|econ|business|manag|finance/.test(d)) return { grad: "#C0A12B,#E6D58A", icon: "\u{1F4CA}" };
  if (/农|林|食品|agri|food|forest/.test(d)) return { grad: "#6D8C2A,#C5D86D", icon: "\u{1F33E}" };
  if (/心理|psycho|认知|behav/.test(d)) return { grad: "#AD1457,#F48FB1", icon: "\u{1F9E0}" };
  if (/教育|educat|teach/.test(d)) return { grad: "#00838F,#80DEEA", icon: "\u{1F4DA}" };
  if (/数学|统计|math|statis/.test(d)) return { grad: "#283593,#9FA8DA", icon: "\u{1F4D0}" };
  return { grad: "#455A64,#B0BEC5", icon: "\u{1F4D6}" };
}

// ============ 区块 1: Hero 首图 ============
function renderHeroBlock(journal: JournalInfo): string {
  const fullName = esc(journal.nameEn || journal.name);
  const cnName = journal.nameEn && journal.name && journal.name !== journal.nameEn
    ? esc(journal.name) : "";
  const cover = journal.coverUrl || (journal as any).coverImageUrl;
  // PR #135 (5-12): IF NULL → 整 badge skip, 不显灰 "IF 暂无" 占位（user 反馈假数据感）.
  const ifBadge = journal.impactFactor != null && journal.impactFactor > 0
    ? `<div style="display:inline-block;padding:8px 16px;margin-top:12px;background:${RED};color:#fff;border-radius:8px;font-size:18px;font-weight:bold;line-height:1.3;">IF ${esc(String(journal.impactFactor))}</div>`
    : "";

  // PR #184 (5-20): 封面观感统一 —
  //   有真封面图 → 渲染 <img>; 无封面图 → 统一品牌化占位卡 (渐变底 + 期刊名大字),
  //   不再出现"有些带图、有些纯文字"的不一致 (运营反馈).
  let coverHtml: string;
  if (cover) {
    coverHtml = `<img src="${esc(cover)}" alt="${fullName}" style="max-width:100%;height:auto;display:block;margin:0 auto 12px auto;border-radius:6px;" />`;
  } else {
    // PR #191: 无真封面 → 学科主题题图 (学科色渐变 + 大图标 + 期刊名), 替代纯文字占位卡
    const theme = disciplineTheme((journal as { discipline?: string | null }).discipline);
    coverHtml =
      `<div style="background:linear-gradient(135deg,${theme.grad});border-radius:10px;padding:40px 24px;margin:0 auto 12px auto;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.12);">` +
      `<div style="font-size:56px;line-height:1;margin-bottom:14px;">${theme.icon}</div>` +
      `<p style="margin:0;font-size:22px;font-weight:bold;color:#fff;line-height:1.4;letter-spacing:0.5px;text-shadow:0 1px 3px rgba(0,0,0,0.25);">${fullName}</p>` +
      (cnName ? `<p style="margin:10px 0 0 0;font-size:15px;color:rgba(255,255,255,0.92);line-height:1.5;">${cnName}</p>` : "") +
      `</div>`;
  }

  return `<section style="margin:0 0 22px 0;text-align:center;">` +
    coverHtml +
    `<p style="margin:0;font-size:18px;font-weight:bold;color:${RED};line-height:1.5;">${fullName}</p>` +
    (cnName ? `<p style="margin:4px 0 0 0;font-size:14px;color:${TEXT};line-height:1.5;">${cnName}</p>` : "") +
    ifBadge +
    `</section>`;
}

// ============ 区块 2: 期刊基本信息卡 ============
function renderBasicInfoBlock(journal: JournalInfo): string {
  // PR #135 (5-12 demo blocker): NULL 字段整行不渲染（user 反馈"暂无"满屏假数据感）.
  // 与 PR #117 (website 行) + PR #126 (chart 区) 同 idiom.
  const lines: string[] = [];
  if (journal.issn) lines.push(`<strong>ISSN：</strong>${esc(journal.issn)}`);
  if (journal.publisher) lines.push(`<strong>Publisher：</strong>${esc(journal.publisher)}`);
  if (journal.foundingYear) lines.push(`<strong>创刊年：</strong>${esc(String(journal.foundingYear))}`);
  if (journal.country) lines.push(`<strong>出版国：</strong>${esc(journal.country)}`);
  // PR #117 fix Bug 2：website NULL/空时整行不渲染（避免假"查看官网"链接）
  // user 5-11 反馈：prod 多数 multi_source 期刊 website 字段 NULL → 模板显示"暂无"被误以为"假链接"
  // 降级方案：仅当真有合法 http(s) URL 才渲染"官网："行
  // PR #180 曾改成 NULL → fallback Google 搜索, 但 user 测试反馈跳 Google 体验差
  // PR #182 (5-19, A 方案): website 字段 NULL 或 Springer 登录页 → 整行 skip (按钮直接藏)
  //   现状: backfill 后 514/527 = 97.5% 有真 website, 剩 13 个 NULL = 中文/停刊期刊, 这部分直接不渲染
  const isSpringerLogin = journal.website && /idp\.springer\.com/i.test(journal.website);
  if (journal.website && /^https?:\/\//i.test(journal.website) && !isSpringerLogin) {
    const safe = esc(journal.website);
    const anchorText = journal.website.length > 50 ? "查看官网 →" : safe;
    lines.push(`<strong>官网：</strong><a href="${safe}" target="_blank" rel="noopener noreferrer" style="color:${BLUE};text-decoration:none;">${anchorText}</a>`);
  }
  // else: 不渲染"官网："行 (A 方案 — 无真官网就藏按钮, 不引导用户去 Google 搜索)

  const ps = lines
    .map((l) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">${l}</p>`)
    .join("");

  return `<section style="margin:0 0 18px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
    ps +
    `</section>`;
}

// ============ 区块 3: JCR 分区徽章 ============
function renderJcrQuartileBlock(journal: JournalInfo): string {
  let q = journal.partition;
  let valid = typeof q === "string" && /^Q[1-4]$/i.test(q);
  // PR #195 (5-20): partition(中科院, 多 NULL) 空时 fallback 到 jcrFull.jifSubjects 最优 zone.
  if (!valid) {
    const raw = (journal as { jcrFull?: unknown }).jcrFull;
    if (isJcrFull(raw) && Array.isArray(raw.jifSubjects)) {
      const zones = (raw.jifSubjects as Array<{ zone?: string }>)
        .map((s) => s.zone)
        .filter((z): z is string => typeof z === "string" && /^Q[1-4]$/i.test(z));
      if (zones.length > 0) {
        q = zones.sort()[0].toUpperCase();
        valid = true;
      }
    }
  }
  const display = valid ? q!.toUpperCase() : "未分区";
  const bg = valid ? RED : "#BDBDBD";
  const tip = valid ? "JCR 分区" : "JCR 分区数据未公布";

  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<div style="display:inline-block;padding:10px 22px;background:${bg};color:#fff;border-radius:6px;font-size:18px;font-weight:bold;line-height:1.4;">${esc(display)}</div>` +
    `<p style="margin:6px 0 0 0;font-size:12px;color:${MUTED};line-height:1.6;">${esc(tip)}</p>` +
    `</section>`;
}

// ============ 区块 4: IF 历史折线图（C 阶段：SVG 渲染） ============
function renderIfHistoryChart(journal: JournalInfo): string {
  // PR B.10：读 ifHistoryRaw（V12 raw from DB / LetPub V7 包装），不读 ifHistory（V7 LetPub array）
  const raw = (journal as any).ifHistoryRaw;
  if (!isIfHistory(raw)) {
    return renderP1Placeholder({
      title: "近 10 年影响因子",
      icon: "📈",
      message: "数据采集中",
      submessage: "数据完善中，敬请期待",
    });
  }
  // shape 容忍：data 项可能 { year, if } 或 { year, value }
  const series = raw.data
    .map((d) => ({ year: d.year, if: typeof d.if === "number" ? d.if : (d.value ?? NaN) }))
    .filter((d) => isFinite(d.if));
  const svg = renderIfHistoryLineChart(series);
  if (!svg) {
    // 单点 / 空数据 → 走 P1 占位
    return renderP1Placeholder({
      title: "近 10 年影响因子",
      icon: "📈",
      message: `已收集 ${series.length} 年数据`,
      submessage: "数据点较少，更多数据完善中",
    });
  }
  return (
    `<section style="margin:0 0 22px 0;">` +
    `<h3 style="margin:0 0 12px 0;font-size:16px;color:${RED};font-weight:bold;">📈 近 10 年影响因子</h3>` +
    svg +
    `</section>`
  );
}

// ============ 区块 5: IF 最新值 + 同比变化 ============
function renderImpactFactorBlock(journal: JournalInfo): string {
  const if_ = journal.impactFactor;
  // PR #146 (5-14): NULL → 整块 skip（跟 PR #135/#136 jcrRow 哲学一致，不显灰"暂无"）
  if (if_ == null) return "";

  // 同比：从 if_history 推算（PR B.10：用 ifHistoryRaw 与 chart 槽位对齐）
  let yoy = "";
  const raw = (journal as any).ifHistoryRaw;
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
  // PR #196 (5-21): CAR 止血 — carIndexHistory 来自 openalex cn/total 自算, 与 jcarindex 差别大, 暂关 (task #57 接 jcarindex 后恢复).
  void journal;
  return "";
  // eslint-disable-next-line no-unreachable
  const raw = (journal as any).carIndexHistory;
  if (!isCarIndexHistory(raw) || !Array.isArray(raw.data) || raw.data.length === 0) {
    return renderP1Placeholder({
      title: "CAR 指数（中国作者占比）",
      icon: "🎯",
      message: "数据采集中",
      submessage: "数据完善中，敬请期待",
    });
  }
  const risk = raw.riskLevel === "low" ? "低风险" : raw.riskLevel === "high" ? "高风险" : "中等风险";
  const riskColor = raw.riskLevel === "low" ? "#388E3C" : raw.riskLevel === "high" ? "#D32F2F" : "#F57C00";
  const warned = (raw as any).isWarningListed ? `<span style="margin-left:6px;padding:2px 6px;background:#FFEBEE;color:#C62828;border-radius:3px;font-size:11px;">⚠ 中科院预警</span>` : "";
  const svg = renderCarHistoryLineChart(raw.data, raw.riskLevel ?? "mid");
  // svg 空（< 2 数据点）→ fallback 老 tag list
  const body = svg
    ? `<div style="margin:6px 0 0 0;">${svg}</div>`
    : `<div style="padding:10px 12px;background:#FAFAFA;border-radius:6px;text-align:center;">${raw.data.map((r: { year: number; carIndex: number }) => `<span style="display:inline-block;margin:0 6px 4px 0;padding:3px 8px;background:#F5F5F5;color:${TEXT};border-radius:4px;font-size:12px;line-height:1.6;"><strong>${r.year}</strong>: ${(r.carIndex * 100).toFixed(2)}%</span>`).join("")}</div>`;
  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 8px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">🎯 CAR 指数（中国作者占比）</p>` +
    `<p style="margin:0 0 6px 0;text-align:center;font-size:14px;line-height:1.6;"><span style="color:${riskColor};font-weight:600;">${risk}</span>${warned}</p>` +
    body +
    `</section>`;
}

// ============ 区块 7: JCR 详细面板（P3 隐藏 / P2 灰阶） ============
function renderJcrFullPanel(journal: JournalInfo): string {
  const raw = (journal as any).jcrFull;
  // B.4-1：CSCD / 北大核心标签独立信号（中文核心目录），即便 jcrFull 为空也渲染
  const cscd = (journal as any).cscdLevel as string | null | undefined;
  const pku = (journal as any).pkuCoreLevel as string | null | undefined;
  const hasZhCore = (typeof cscd === "string" && cscd.trim()) || (typeof pku === "string" && pku.trim());

  if (!isJcrFull(raw) && !hasZhCore) {
    return ""; // P3 隐藏：JCR / 中文核心皆无
  }
  const rows: string[] = [];

  if (isJcrFull(raw)) {
    rows.push(jcrRow("WoS 等级", raw.wosLevel));
    rows.push(jcrRow("JIF 学科分区", formatJcrSubjects(raw.jifSubjects)));
    rows.push(jcrRow("JCI 学科分区", formatJcrSubjects(raw.jciSubjects)));
    rows.push(jcrRow("是否顶刊", typeof raw.isTopJournal === "boolean" ? (raw.isTopJournal ? "是" : "否") : null));
    rows.push(jcrRow("是否综述刊", typeof raw.isReviewJournal === "boolean" ? (raw.isReviewJournal ? "是" : "否") : null));
  }
  // B.4-1：中文核心目录（CSCD + 北大核心）— 静态目录字段，B.4-2 万方 / B.4-3 CNKI 后再扩
  if (typeof cscd === "string" && cscd.trim()) rows.push(jcrRow("CSCD", cscd));
  if (typeof pku === "string" && pku.trim()) rows.push(jcrRow("北大核心", pku));

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">JCR 详细</p>` +
    `<div style="padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
      rows.join("") +
    `</div>` +
    `</section>`;
}

function jcrRow(label: string, value: string | null | undefined): string {
  // PR #136 (5-12 demo blocker): NULL value 整行不渲染（原"暂无"假数据感）.
  if (value == null || value === "") return "";
  return `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};"><strong>${esc(label)}：</strong>${esc(String(value))}</p>`;
}

// PR #198 (5-21): JCR 学科名英→中翻译 (高频 JCR subject), 未匹配保留英文. 改善中国用户阅读.
const JCR_SUBJECT_CN: Record<string, string> = {
  "MEDICINE, GENERAL & INTERNAL": "医学·综合与内科", "MEDICINE, RESEARCH & EXPERIMENTAL": "医学·研究与实验",
  "ONCOLOGY": "肿瘤学", "CARDIAC & CARDIOVASCULAR SYSTEMS": "心血管", "CLINICAL NEUROLOGY": "临床神经病学",
  "SURGERY": "外科学", "IMMUNOLOGY": "免疫学", "INFECTIOUS DISEASES": "传染病学", "PHARMACOLOGY & PHARMACY": "药理学与药学",
  "PUBLIC, ENVIRONMENTAL & OCCUPATIONAL HEALTH": "公共卫生与环境职业健康", "HEALTH CARE SCIENCES & SERVICES": "卫生保健科学",
  "NEUROSCIENCES": "神经科学", "PSYCHIATRY": "精神病学", "RADIOLOGY, NUCLEAR MEDICINE & MEDICAL IMAGING": "放射与医学影像",
  "BIOCHEMISTRY & MOLECULAR BIOLOGY": "生物化学与分子生物学", "CELL BIOLOGY": "细胞生物学", "MICROBIOLOGY": "微生物学",
  "BIOTECHNOLOGY & APPLIED MICROBIOLOGY": "生物技术与应用微生物", "GENETICS & HEREDITY": "遗传学", "PLANT SCIENCES": "植物科学",
  "BIOLOGY": "生物学", "ECOLOGY": "生态学", "MARINE & FRESHWATER BIOLOGY": "海洋与淡水生物",
  "CHEMISTRY, MULTIDISCIPLINARY": "化学·综合", "CHEMISTRY, PHYSICAL": "物理化学", "CHEMISTRY, ANALYTICAL": "分析化学",
  "CHEMISTRY, ORGANIC": "有机化学", "CHEMISTRY, INORGANIC & NUCLEAR": "无机与核化学", "ELECTROCHEMISTRY": "电化学",
  "MATERIALS SCIENCE, MULTIDISCIPLINARY": "材料科学·综合", "NANOSCIENCE & NANOTECHNOLOGY": "纳米科学",
  "POLYMER SCIENCE": "高分子科学", "METALLURGY & METALLURGICAL ENGINEERING": "冶金工程",
  "ENGINEERING, ELECTRICAL & ELECTRONIC": "工程·电子电气", "ENGINEERING, MECHANICAL": "工程·机械", "ENGINEERING, CHEMICAL": "工程·化工",
  "ENGINEERING, CIVIL": "工程·土木", "ENGINEERING, ENVIRONMENTAL": "工程·环境", "AUTOMATION & CONTROL SYSTEMS": "自动化与控制",
  "COMPUTER SCIENCE, ARTIFICIAL INTELLIGENCE": "计算机·人工智能", "COMPUTER SCIENCE, INFORMATION SYSTEMS": "计算机·信息系统",
  "COMPUTER SCIENCE, THEORY & METHODS": "计算机·理论方法", "TELECOMMUNICATIONS": "电信",
  "ENERGY & FUELS": "能源与燃料", "ENVIRONMENTAL SCIENCES": "环境科学", "GREEN & SUSTAINABLE SCIENCE & TECHNOLOGY": "绿色可持续科技",
  "PHYSICS, MULTIDISCIPLINARY": "物理·综合", "PHYSICS, APPLIED": "应用物理", "OPTICS": "光学", "ASTRONOMY & ASTROPHYSICS": "天文与天体物理",
  "MATHEMATICS": "数学", "MATHEMATICS, APPLIED": "应用数学", "STATISTICS & PROBABILITY": "统计与概率",
  "ECONOMICS": "经济学", "MANAGEMENT": "管理学", "BUSINESS": "商业", "BUSINESS, FINANCE": "金融",
  "AGRICULTURE, MULTIDISCIPLINARY": "农业·综合", "FOOD SCIENCE & TECHNOLOGY": "食品科学", "AGRONOMY": "农艺学",
  "EDUCATION & EDUCATIONAL RESEARCH": "教育学", "PSYCHOLOGY, MULTIDISCIPLINARY": "心理学·综合",
  "SOCIAL SCIENCES, INTERDISCIPLINARY": "社会科学·交叉", "MULTIDISCIPLINARY SCIENCES": "综合性期刊",
};
function translateJcrSubject(s: string): string {
  return JCR_SUBJECT_CN[s.toUpperCase().trim()] || s; // 未匹配保留英文
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
      return `${translateJcrSubject(s.subject)}${meta.length > 0 ? `（${meta.join(" · ")}）` : ""}`;
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
      submessage: "学科分布数据完善中",
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
      submessage: "学科分布数据完善中",
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
  rows.push(jcrRow("快速通道", isFast == null ? null : (isFast ? "支持" : "不支持")));

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
  // PR #146 (5-14): NULL → 整块 skip（原 greyOrValue 兜底成灰"未知"，被 PR #135/#136 漏掉）
  if (!freq) return "";

  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.6;">出版周期</p>` +
    `<p style="margin:0;font-size:16px;font-weight:600;color:${TEXT};line-height:1.5;">${esc(freq)}</p>` +
    `</section>`;
}

// ============ 区块 11: 年发文量柱状图（C 阶段：SVG 渲染） ============
function renderAnnualVolumeChart(journal: JournalInfo): string {
  const raw = (journal as any).publicationStats;
  if (isPublicationStats(raw) && Array.isArray(raw.annualVolumeHistory) && raw.annualVolumeHistory.length > 0) {
    const svg = renderAnnualVolumeBarChart(raw.annualVolumeHistory);
    if (svg) {
      return (
        `<section style="margin:0 0 22px 0;">` +
        `<h3 style="margin:0 0 12px 0;font-size:16px;color:${RED};font-weight:bold;">📊 近 10 年发文量</h3>` +
        svg +
        `</section>`
      );
    }
  }
  return renderP1Placeholder({
    title: "近 10 年发文量",
    icon: "📊",
    message: "数据采集中",
    submessage: "数据完善中，敬请期待",
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

// ============ 区块 13: 引用前 10 期刊 ============
function renderCitingJournalsPie(journal: JournalInfo): string {
  const raw = (journal as any).citingJournalsTop10;
  if (!isCitingJournalsTop10(raw) || raw.topJournals.length === 0) {
    return renderP1Placeholder({
      title: "引用前 10 种期刊",
      icon: "📊",
      message: "数据采集中",
      submessage: "Top 期刊排行数据完善中",
    });
  }
  const svg = renderCitingPieChart(
    raw.topJournals.slice(0, 10),
    (raw as any).selfCitationRate,
    (raw as any).selfCitationConfidence,
  );
  const body = svg
    ? `<div style="margin:6px 0 0 0;">${svg}</div>`
    : `<ol style="margin:0;padding:12px 16px 12px 28px;background:#FAFAFA;border-radius:6px;list-style:none;">${raw.topJournals.slice(0, 10).map((j, i) => {
        const pct = typeof j.percent === "number" ? `${j.percent}%` : "";
        return `<li style="margin:0 0 4px 0;font-size:13px;color:${TEXT};line-height:1.6;"><span style="color:${MUTED};">${i + 1}.</span> ${esc(j.name)}${pct ? ` <span style="color:${BLUE};font-weight:600;">${pct}</span>` : ""}</li>`;
      }).join("")}</ol>`;
  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">📊 引用前 ${raw.topJournals.length} 期刊分布</p>` +
    body +
    `</section>`;
}

// ============ 区块 14: 自引率徽章 ============
function renderSelfCitationBadge(journal: JournalInfo): string {
  const raw = (journal as any).citingJournalsTop10;
  if (!isCitingJournalsTop10(raw)) return ""; // P3 隐藏（无引用数据）
  const rate = (raw as any).selfCitationRate;
  const conf = (raw as any).selfCitationConfidence;
  // confidence='low'（top-N=100 sample COVID 噪声）→ 不渲染数值，留 P1 占位
  // task #50 升级 medium 后自动展示
  if (typeof rate !== "number" || conf === "low") {
    return `<section style="margin:0 0 18px 0;text-align:center;padding:10px 14px;background:#FAFAFA;border-radius:6px;">` +
      `<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.6;">自引率数据采集中</p>` +
      `</section>`;
  }
  const pct = rate * 100;
  const risk = pct < 5 ? "低" : pct < 15 ? "中" : "高";
  const color = pct < 5 ? "#388E3C" : pct < 15 ? "#F57C00" : "#D32F2F";
  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.6;">自引率</p>` +
    `<p style="margin:0;font-size:20px;font-weight:bold;color:${color};line-height:1.4;">${pct.toFixed(1)}% · ${risk}风险</p>` +
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

// ============ 区块 15a-15d: V7 深度分析 4 章（AI 真数据驱动） ============
// 4 字段独立渲染（不合并）。LLM 缺数据时返回 1-2 句通用描述，不阻断流程。
// 字段为空（undefined / 空串）时整段 <section> 不输出（P3 隐藏，与区块 7/12/14 风格一致）。
function renderDeepAnalysisSection(title: string, html: string | undefined): string {
  if (!html || !html.trim()) return "";
  // PR Q.10.2：拆段 threshold 150→80，每段 buffer 100→50（5-9 实测拆 2 段，期望 5-7 段）。
  // 裸数字自动 <strong> 包裹同 Q.10.1。
  const splitParagraph = (inner: string, attrs: string): string => {
    if (inner.length <= 80) return `<p${attrs}>${inner}</p>`;
    const sentences = inner.split(/(?<=[。！？])/).filter((s) => s.trim());
    if (sentences.length < 2) return `<p${attrs}>${inner}</p>`;
    const chunks: string[] = []; let buf = "";
    for (const s of sentences) { if ((buf + s).length > 50 && buf) { chunks.push(buf); buf = s; } else buf += s; }
    if (buf) chunks.push(buf);
    return chunks.map((c) => `<p${attrs}>${c}</p>`).join("");
  };
  let processed = html.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/g, (_, a, i) => splitParagraph(i, a));
  processed = processed.replace(/(\b\d+\.\d{1,3}\b|\b\d+%|\b\d{4}\s*年\b)/g, (m, _g, off, str: string) => {
    const before = str.slice(Math.max(0, off - 30), off);
    return /<strong[^>]*>[^<]*$/.test(before) ? m : `<strong>${m}</strong>`;
  });
  // PR Q.10.2：strong 改 color + underline 视觉信号（5-9 实测微信 strip background → 浅底无效）。
  // 多重信号叠加：主色字 + 700 粗体 + 主色 2px 下划线 + 1.05em 略大 — 公众号都保留。
  const polished = processed
    .replace(/<p\b(?![^>]*style=)/g, '<p style="margin:0 0 12px 0;line-height:1.95;"')
    .replace(/<li\b(?![^>]*style=)/g, '<li style="margin:0 0 6px 0;line-height:1.85;"')
    .replace(/<strong\b(?![^>]*style=)/g, '<strong style="color:{{PRIMARY}};font-weight:700;text-decoration:underline;text-decoration-color:{{PRIMARY}};text-decoration-thickness:2px;text-underline-offset:3px;font-size:1.05em;padding:0 2px;"');
  return `<section style="margin:0 0 22px 0;padding:18px 20px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 12px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">${esc(title)}</p>` +
    `<div style="margin:0;font-size:13px;line-height:1.95;color:${TEXT};">${polished}</div>` +
    `</section>`;
}

function renderIfHistoryAnalysis(ai: AIGeneratedContent): string {
  return renderDeepAnalysisSection("📈 IF 趋势深度分析", ai.ifHistoryAnalysis);
}
function renderCarRiskAnalysis(ai: AIGeneratedContent): string {
  // PR #196: CAR 止血 — 基于不准的 CAR 数据, 暂关 (task #57 接 jcarindex 后恢复).
  void ai;
  return "";
}
function renderScopeAndCitations(ai: AIGeneratedContent): string {
  return renderDeepAnalysisSection("🔍 收稿范围 & 引用生态", ai.scopeAndCitations);
}
function renderAiSubmissionAdvice(ai: AIGeneratedContent): string {
  // 注意：与区块 17 renderSubmissionAdviceBlock（rule-based 简短）区分
  // PR #202: 去 AI 感 — 砍掉"（AI 综合分析）"标签 (暴露机器味, 加重公式感)
  return renderDeepAnalysisSection("💡 投稿建议", ai.submissionAdvice);
}

// ============ 区块 16: 综合点评（aiContent.recommendation 摘要） ============
// 5-19 hotfix: AI prompt 要 HTML 输出 (article-skill.ts:1223 "用HTML格式"),
// 之前 esc(reco) 把 <p><strong><ul><li> 转成 &lt;p&gt; 字面文本 — 公众号草稿里 raw 显示 HTML 标签.
// 修复: (1) 砍 esc() 直接 inject (与 renderDeepAnalysisSection 一致)
//       (2) 外包 <p> → <div> (reco 内含 <ul>, <ul> 放 <p> 里是 invalid HTML)
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
  // reco 含 AI 生成的 <p><strong><ul><li> 等 HTML, 直接 inject (不 esc)
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">综合点评</p>` +
    `<div style="margin:0;font-size:14px;line-height:1.8;color:${TEXT};">${reco}</div>` +
    `</section>`;
}

// ============ 区块 17: 投稿建议 / 难度评级 ============
function renderSubmissionAdviceBlock(journal: JournalInfo): string {
  const ar = journal.acceptanceRate;
  const rc = journal.reviewCycle;
  // PR #146 (5-14): ar+rc 都空才 skip 整块（"投稿建议"是核心区块，任一字段有值就渲染，
  // 缺的那个内部 greyOrValue 兜底）
  if (ar == null && rc == null) return "";

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
  // PR #146 (5-14): 无 item → 整块 skip（"✅ 优势: 暂无"观感差，不如不显）
  if (items.length === 0) return "";
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
  // PR #146 (5-14): 无 item → 整块 skip（"⚠️ 注意事项: 暂无"观感差，不如不显）
  if (items.length === 0) return "";
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
  // PR Q.6 D5：CTA block 渐变背景改 palette 占位（原硬编码 #1976D2 → 4 套主色 / 辅色注入）
  return `<section style="margin:0 0 22px 0;padding:16px 18px;background:linear-gradient(135deg,{{PRIMARY}},{{ACCENT}});border-radius:8px;text-align:center;">` +
    `<p style="margin:0 0 6px 0;font-size:16px;font-weight:bold;color:#fff;line-height:1.5;">需要投稿协助？</p>` +
    `<p style="margin:0;font-size:14px;color:#E3F2FD;line-height:1.7;">${journalName} 投稿格式审核 / 选题契合度评估 / 同行案例查询，扫码联系小助手</p>` +
    `</section>`;
}

// ============ 区块 21: 联系方式 / 二维码 ============
function renderContactBlock(tenant?: TenantInfo | null): string {
  // tenant.contactMeta 是 unknown（来自 jsonb），用 type guard 校验
  const meta: unknown = tenant?.contactMeta;
  // 缺 tenant / 缺 contact_meta / 缺 contactName → graceful fallback（老板未维护场景）
  if (!isContactMeta(meta)) {
    return `<section style="margin:0 0 18px 0;text-align:center;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
      `<p style="margin:0 0 4px 0;font-size:14px;color:${TEXT};font-weight:600;line-height:1.6;">联系方式</p>` +
      `<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.7;">详见公众号底部二维码 · 工作日 9:00-18:00 答疑</p>` +
      `</section>`;
  }
  const lines: string[] = [];
  if (meta.workingHours) {
    lines.push(`<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.7;">${esc(meta.workingHours)}</p>`);
  }
  if (meta.wechatId) {
    lines.push(`<p style="margin:0 0 4px 0;font-size:13px;color:${TEXT};line-height:1.7;"><strong>微信：</strong>${esc(meta.wechatId)}</p>`);
  }
  if (meta.email) {
    lines.push(`<p style="margin:0 0 4px 0;font-size:13px;color:${TEXT};line-height:1.7;"><strong>邮箱：</strong>${esc(meta.email)}</p>`);
  }
  if (meta.phone) {
    lines.push(`<p style="margin:0 0 4px 0;font-size:13px;color:${TEXT};line-height:1.7;"><strong>电话：</strong>${esc(meta.phone)}</p>`);
  }
  const qr = meta.qrCodeUrl
    ? `<img src="${esc(meta.qrCodeUrl)}" alt="二维码" style="display:block;margin:10px auto 4px auto;width:120px;height:120px;border-radius:4px;"/>`
    : "";
  return `<section style="margin:0 0 18px 0;text-align:center;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 6px 0;font-size:14px;color:${TEXT};font-weight:600;line-height:1.6;">${esc(meta.contactName)}</p>` +
    qr +
    lines.join("") +
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
  _abstracts?: Abstracts,
  tenant?: TenantInfo | null,
  chartConfig?: unknown,
  // PR Q.6 D5：section_count 控制 4 套 region 数差异化（A=23 / B=15 / C=18 / E=25→23）。
  // E=25 实际只渲 23（shunshi 固定 23 区块上限），E 多出靠 chart 数补（D5 chart_config 5 个 chart）。
  sectionCount?: number,
): Promise<string> {
  const sections: string[] = [];
  // PR Q.5 D4：根据 chartConfig.types[] 决定哪些 chart 渲染（4 套模板差异化数量）
  // PR Q.7.2：从 chartConfig.colors 解 palette，末尾 .replaceAll 注入 4 套真色调（user 5-7 D4 验收 root cause：inline CSS hardcoded 覆盖 class CSS）
  const { resolveChartConfig } = await import("../../skills/chart-config-resolver.js");
  const { typesSet, palette } = resolveChartConfig(chartConfig);

  sections.push(renderHeroBlock(journal));                            //  1
  sections.push(renderBasicInfoBlock(journal));                       //  2
  sections.push(renderJcrQuartileBlock(journal));                     //  3
  if (typesSet.has("if-history-line")) sections.push(renderIfHistoryChart(journal)); //  4 🆕
  sections.push(renderImpactFactorBlock(journal));                    //  5 🔄
  if (typesSet.has("car-history-line")) sections.push(renderCarHistoryBlock(journal)); //  6 🆕
  sections.push(renderJcrFullPanel(journal));                         //  7 🆕 (P3)
  sections.push(renderScopeDetailsBlock(journal));                    //  8 🆕
  sections.push(renderPublicationCostsBlock(journal));                //  9 🆕
  sections.push(renderFrequencyBlock(journal));                       // 10 🔄
  if (typesSet.has("annual-volume-bar")) sections.push(renderAnnualVolumeChart(journal)); // 11 🆕
  sections.push(renderTopInstitutionsBlock(journal));                 // 12 🆕 (P3)
  if (typesSet.has("citing-pie")) sections.push(renderCitingJournalsPie(journal)); // 13 🆕
  // PR Q.6 D5：4 新 chart 类型（typesSet 命中才渲）。section wrap 简化（margin / padding 同 shunshi 风格）
  const wrapChart = (svg: string) => svg ? `<section style="margin:0 0 18px 0;padding:8px 0;">${svg}</section>` : "";
  if (typesSet.has("accept-rate-bar")) sections.push(wrapChart(renderAcceptRateBarChart(journal.acceptanceRate ?? null)));
  if (typesSet.has("fee-pie")) sections.push(wrapChart(renderFeePieChart(journal.apcFee ?? null)));
  if (typesSet.has("subject-distribution")) sections.push(wrapChart(renderSubjectDistributionChart(
    (journal.promptScopeDetails?.subjectDistribution as Array<{ subject: string; percent: number }>) ?? [],
  )));
  if (typesSet.has("review-cycle-bar")) sections.push(wrapChart(renderReviewCycleBarChart(journal.reviewCycle ?? null)));
  sections.push(renderSelfCitationBadge(journal));                    // 14 🆕 (P3)
  sections.push(renderRecommendationScoreBlock(journal));             // 15 🆕
  // V7（task #11）：4 个深度分析章节，由 8 enricher 字段真数据驱动 LLM 生成
  sections.push(renderIfHistoryAnalysis(aiContent));                  // 15a 🆕 V7
  sections.push(renderCarRiskAnalysis(aiContent));                    // 15b 🆕 V7
  sections.push(renderScopeAndCitations(aiContent));                  // 15c 🆕 V7
  sections.push(renderAiSubmissionAdvice(aiContent));                 // 15d 🆕 V7
  sections.push(renderSummaryBlock(aiContent));                       // 16
  sections.push(renderSubmissionAdviceBlock(journal));                // 17
  sections.push(renderAdvantagesBlock(journal, aiContent));           // 18
  sections.push(renderCautionsBlock(journal, aiContent));             // 19
  sections.push(renderMarketingCtaBlock(journal));                    // 20
  sections.push(renderContactBlock(tenant));                          // 21 🔄 task #35
  sections.push(renderDisclaimerBlock());                             // 22
  sections.push(renderFooterBlock(journal));                          // 23

  // PR Q.7.2：runtime palette 注入。占位字符串 → palette 实色（4 套主色调真差异化）。
  // PR Q.6 D5：sectionCount 控制 4 套区块数差异化（A=23 默认 / B=15 / C=18 / E=23 上限）。
  const visible = sections.filter((s) => s.length > 0);
  const trimmed = sectionCount && sectionCount < visible.length
    ? visible.slice(0, sectionCount)
    : visible;
  const html = trimmed.join("\n");
  return html
    .replaceAll("{{PRIMARY}}", palette.primary)
    .replaceAll("{{ACCENT}}", palette.accent)
    .replaceAll("{{PRIMARY_BG}}", palette.primaryBg)
    .replaceAll("#FAFAFA", palette.cardBg)
    .replaceAll("#F5F5F5", palette.borderColor);
}
