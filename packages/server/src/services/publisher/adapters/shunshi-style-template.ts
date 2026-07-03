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
  // 老韩 6-15: "占位补满"优先于隐身 — 数据缺也保留结构, muted 小字诚实标注, 不伪装真数据。
  const { title, icon, message, submessage } = _opts;
  return `<section style="margin:0 0 18px 0;padding:16px 18px;background:#FAFAFA;border-radius:6px;text-align:center;">` +
    `<p style="margin:0 0 5px 0;font-size:15px;font-weight:600;color:${TEXT};line-height:1.5;">${esc(icon)} ${esc(title)}</p>` +
    `<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.6;">${esc(message)}${submessage ? " · " + esc(submessage) : ""}</p>` +
    `</section>`;
}

/** 数据缺失时的诚实占位 (老韩 6-15: 占位补满优先于隐身)。muted 小字, 不伪装成真数据。 */
function renderMissingDataBlock(title: string, note = "暂无公开数据"): string {
  return `<section style="margin:0 0 18px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;text-align:center;">` +
    `<p style="margin:0 0 4px 0;font-size:14px;font-weight:600;color:${TEXT};line-height:1.5;">${esc(title)}</p>` +
    `<p style="margin:0;font-size:13px;color:${MUTED};line-height:1.6;">${esc(note)}</p>` +
    `</section>`;
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

  // 6-17: 渐变占位卡里已经有刊名了, 卡下不再重复一遍(消除"标题出现两次")。只在真图封面(无文字)下补标题。
  const titleUnder = cover
    ? `<p style="margin:0;font-size:18px;font-weight:bold;color:${RED};line-height:1.5;">${fullName}</p>` +
      (cnName ? `<p style="margin:4px 0 0 0;font-size:14px;color:${TEXT};line-height:1.5;">${cnName}</p>` : "")
    : "";
  return `<section style="margin:0 0 22px 0;text-align:center;">` +
    coverHtml +
    titleUnder +
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
    // PR #208: 锚文本显示域名 (如 www.cell.com →) 而非笼统"查看官网", 更有信息量且一致.
    //   超长完整 URL 仍折叠成域名, 短 URL 直接显示。
    let host = journal.website;
    try { host = new URL(journal.website).hostname; } catch { /* 非法 URL 已被上面 regex 挡掉, 兜底用原值 */ }
    const anchorText = `${esc(host)} →`;
    lines.push(`<strong>官网：</strong><a href="${safe}" target="_blank" rel="noopener noreferrer" style="color:${BLUE};text-decoration:none;">${anchorText}</a>`);
  }
  // else: 不渲染"官网："行 (A 方案 — 无真官网就藏按钮, 不引导用户去 Google 搜索)

  // 6-17: 没有任何字段就别渲染一个空灰框(截图里标题下那条空白盒就是这么来的)。
  if (lines.length === 0) return "";
  const ps = lines
    .map((l) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">${l}</p>`)
    .join("");

  return `<section style="margin:0 0 18px 0;padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
    ps +
    `</section>`;
}

// 6-17: 是否有 WoS/SCI 数据信号。国内刊(CSCD/CSSCI/北大核心中文刊)没有 JCR/IF/分区/CAR 这些概念,
// 套用 WoS 版块只会满屏"未分区/数据采集中/暂无公开数据"占位 → 空洞。无信号则判为国内刊, 跳过这些版块。
function hasWosData(journal: JournalInfo): boolean {
  const raw = (journal as { jcrFull?: unknown }).jcrFull;
  const hasJif = isJcrFull(raw) && Array.isArray(raw.jifSubjects) && raw.jifSubjects.length > 0;
  const ifv = (journal as { impactFactor?: number | null }).impactFactor;
  const hasIf = typeof ifv === "number" && ifv > 0;
  const q = (journal as { partition?: string | null }).partition;
  const hasQ = typeof q === "string" && /^Q[1-4]$/i.test(q);
  return hasJif || hasIf || hasQ;
}

// 6-20 国内刊专属凭证块: 中文核心收录做视觉主角(替代国外刊的分区徽章) + 知网复合影响因子 + CN刊号/主办/刊期。
//   只用最可靠的目录字段(catalogs/cscdLevel/pkuCoreLevel)+ 已采集的复合IF; 无任何凭证则返回""自跳过。
function renderDomesticCredentialBlock(journal: JournalInfo): string {
  const j = journal as unknown as Record<string, unknown>;
  const cat: string[] = Array.isArray(j.catalogs) ? (j.catalogs as unknown[]).map((x) => String(x)) : [];
  const has = (k: string) => cat.includes(k) || j.catalogType === k;
  const badges: string[] = [];
  if (j.pkuCoreLevel || has("pku-core")) badges.push("北大核心");
  if (has("cssci")) badges.push(typeof j.coreLevel === "string" && /扩展/.test(j.coreLevel) ? "CSSCI扩展版" : "CSSCI");
  if (j.cscdLevel || has("cscd")) badges.push(`CSCD${/扩展/.test(String(j.cscdLevel ?? "")) ? "扩展库" : "核心库"}`);
  if (has("cstpcd")) badges.push("科技核心");
  const compIfRaw = typeof j.compositeIF === "number" ? j.compositeIF
    : (typeof j.compositeImpactFactor === "number" ? j.compositeImpactFactor : null);
  const compIf = typeof compIfRaw === "number" && compIfRaw > 0 ? compIfRaw : null;
  if (badges.length === 0 && compIf == null) return ""; // 无凭证不渲染(自跳过)

  const badgeHtml = badges.map((b) =>
    `<span style="display:inline-block;margin:0 6px 8px 0;padding:8px 16px;background:${RED};color:#fff;border-radius:8px;font-size:15px;font-weight:bold;line-height:1.3;">${esc(b)}</span>`
  ).join("");
  const ifHtml = compIf != null
    ? `<div style="margin-top:6px;"><span style="display:inline-block;padding:8px 16px;background:${BLUE};color:#fff;border-radius:8px;font-size:16px;font-weight:bold;line-height:1.3;">复合影响因子 ${esc(compIf.toFixed(3))}</span><span style="margin-left:8px;font-size:12px;color:${MUTED};">数据来源：知网</span></div>`
    : "";
  const info: string[] = [];
  const cn = j.cnNumber, org = j.organizerName || (journal as { publisher?: string }).publisher;
  if (typeof cn === "string" && cn.trim()) info.push(`CN ${esc(cn)}`);
  if (typeof org === "string" && org.trim()) info.push(`主办：${esc(org)}`);
  if (journal.frequency) info.push(esc(String(journal.frequency)));
  const infoHtml = info.length ? `<p style="margin:10px 0 0 0;font-size:13px;color:${MUTED};line-height:1.6;">${info.join(" · ")}</p>` : "";

  return `<section style="margin:0 0 18px 0;padding:16px;background:#FAFAFA;border-radius:8px;text-align:center;">` +
    `<p style="margin:0 0 10px 0;font-size:13px;color:${MUTED};line-height:1.5;">期刊收录与认可</p>` +
    badgeHtml + ifHtml + infoHtml +
    `</section>`;
}

// ============ 区块 3: JCR 分区徽章 ============
function renderJcrQuartileBlock(journal: JournalInfo): string {
  // 6-17: 优先用 jifSubjects 最优 zone(与下方"JCR 详细"面板同源), 消除顶部徽标 Q3 / 详细 Q2 自相矛盾。
  let q: string | null | undefined;
  let valid = false;
  const raw = (journal as { jcrFull?: unknown }).jcrFull;
  if (isJcrFull(raw) && Array.isArray(raw.jifSubjects)) {
    const zones = (raw.jifSubjects as Array<{ zone?: string }>)
      .map((s) => s.zone)
      .filter((z): z is string => typeof z === "string" && /^Q[1-4]$/i.test(z));
    if (zones.length > 0) { q = zones.sort()[0].toUpperCase(); valid = true; }
  }
  if (!valid && typeof journal.partition === "string" && /^Q[1-4]$/i.test(journal.partition)) {
    q = journal.partition; valid = true;
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
  // 6-21: 缺数据整块跳过, 不再吐"数据采集中"占位(补 ca8e91b/PR#136 漏掉的此 caller, 国内刊普遍无 IF 历史 → 占位即空洞)。
  if (!isIfHistory(raw)) return "";
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
  // PR #209: IF<=0 是占位值(非真实IF), 同样 skip — 防止渲染成"最新影响因子 0"
  if (if_ == null || if_ <= 0) return "";

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
  // PR #213/#215 (5-22): CAR 显示 — 数据源锁死 jcarindex(权威风险库). 表格+文字说明形式(图三).
  //   语义(页面核实): carIndex 是"CAR 指数(学术诚信风险)", 原值即百分数(0.87→"0.87%"), 非占比, 不×100.
  //   文字说明为规则生成(非 AI), 风险结论以 jcarindex sciRiskRank 为准, 不自行重算. 7-03: 0/缺失年份不再渲染(无"未公布"占位列), 全空整块隐藏.
  const raw = (journal as any).carIndexHistory as
    | { data?: Array<{ year: number; carIndex: number }>; riskRankText?: string | null; problemArticles?: { current?: number | null; last?: number | null }; source?: string }
    | null;
  if (!raw || raw.source !== "jcarindex") return "";

  const rows = (Array.isArray(raw.data) ? raw.data : []).slice().sort((a, b) => a.year - b.year);
  const known = rows.filter((d) => typeof d.carIndex === "number" && d.carIndex > 0);
  // 6-17: jcarindex 未给显式风险等级但有数据时, 按"CAR<5%=低"自行判定, 避免"有 0.84% 数据却显示风险等级未知"的矛盾。
  let rank = raw.riskRankText || "";
  if (!rank && known.length > 0) {
    const maxCar = Math.max(...known.map((d) => d.carIndex));
    rank = maxCar < 5 ? "低" : maxCar < 10 ? "中" : "高";
  }
  const riskText = rank === "高" ? "高风险" : rank === "中" ? "中等风险" : rank === "低" ? "低风险" : "";
  const riskColor = rank === "高" ? "#D32F2F" : rank === "中" ? "#F57C00" : "#388E3C";
  // 7-03 ③(老韩截图实锤): CAR 数据点全空 → 整块隐藏。原先"有风险等级就渲染"会出
  // "2024 2025 2026 未公布未公布未公布"的空表, 比不渲染更伤信任。
  if (known.length === 0) return "";

  // ---- 文字说明 (规则生成, 结论以 jcarindex 风险等级为准) ----
  const yearPhrase = known.map((d) => `${d.year} 年 ${d.carIndex.toFixed(2)}%`).join("、");
  const conclusion =
    rank === "高" ? "属高风险刊，建议谨慎评估或避开"
    : rank === "中" ? "属中等风险，投稿前留意论文合规与送审"
    : rank === "低" ? "属低风险" // 7-03 ③: 删承诺性收尾话术(留数据与等级, 不替读者拍板投稿决策)
    : "风险等级暂未公布";
  const intro =
    `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.8;color:${TEXT};">` +
    `<strong style="color:${BLUE};">CAR 指数（学术诚信风险）：</strong>据 jcarindex 查询，该刊${known.length > 0 ? ` ${yearPhrase}` : "近年 CAR 指数暂未公布"}。CAR 指数 &lt;5% 为低风险；该刊风险等级为 <span style="color:${riskColor};font-weight:700;">${riskText || "未知"}</span>，${conclusion}。` +
    `</p>`;

  // ---- 表格 (年份 × CAR 指数, 7-03: 只出有真值的年份列) ----
  let table = "";
  // 7-03 ③: 只渲染有真值的年份列 — 部分年份缺失时不再出"未公布"占位列(截图事故根因)
  if (known.length > 0) {
    const headCells = known.map((d) => `<th style="padding:7px 10px;font-size:13px;background:${BLUE};color:#fff;font-weight:600;text-align:center;border-right:1px solid rgba(255,255,255,0.25);">${d.year}</th>`).join("");
    const valCells = known
      .map((d) => {
        const v = `${d.carIndex.toFixed(2)}%`;
        return `<td style="padding:7px 10px;font-size:13px;color:${TEXT};text-align:center;border-right:1px solid #EEE;border-bottom:1px solid #EEE;">${v}</td>`;
      })
      .join("");
    table =
      `<table style="width:100%;border-collapse:collapse;border-radius:6px;overflow:hidden;">` +
      `<thead><tr style="background:${BLUE};"><th style="padding:7px 10px;font-size:13px;background:${BLUE};color:#fff;font-weight:600;text-align:left;border-right:1px solid rgba(255,255,255,0.25);">CAR 指数</th>${headCells}</tr></thead>` +
      `<tbody><tr><td style="padding:7px 10px;font-size:13px;color:${MUTED};border-right:1px solid #EEE;border-bottom:1px solid #EEE;">年度</td>${valCells}</tr></tbody>` +
      `</table>`;
  }

  const pa = raw.problemArticles;
  const problemLine =
    pa && (typeof pa.current === "number" || typeof pa.last === "number")
      ? `<p style="margin:10px 0 0 0;text-align:center;font-size:13px;color:${MUTED};line-height:1.6;">问题文章数：今年 ${pa.current ?? "—"} 篇 · 去年 ${pa.last ?? "—"} 篇</p>`
      : "";

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">🎯 CAR 指数（学术诚信风险）</p>` +
    intro +
    table +
    problemLine +
    `<p style="margin:8px 0 0 0;text-align:center;font-size:11px;color:${MUTED};line-height:1.5;">数据来源：jcarindex 学术诚信风险指数</p>` +
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
  // PR #210 (5-22): 砍 OpenAlex 派生 — scope_details(收稿范围/学科分布)是 OpenAlex concepts,
  //   噪声极大(医学刊会挂 Economics/Business/Decision Sciences), 老韩定调不准则关停. 整块不渲染.
  void journal;
  return "";
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

  const body = rows.join("");
  if (!body) return ""; // 无任何版面费数据 → 整块隐藏, 不显示空框
  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:18px;font-weight:bold;color:${BLUE};text-align:center;line-height:1.5;">版面费</p>` +
    `<div style="padding:12px 16px;background:#FAFAFA;border-radius:6px;">` +
      body +
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
  // 6-20: 国内刊普遍无此数据, 占位会满屏"暂无公开数据"没法发 → 缺数据整块跳过(回归 PR#136/测试期望)。
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
  // 6-20: 缺数据整块跳过, 不渲染"数据采集中"占位(国内刊普遍无, 占位即空洞)。
  return "";
}

// ============ 区块 12: TOP 发文机构（P3 隐藏） ============
function renderTopInstitutionsBlock(journal: JournalInfo): string {
  const raw = (journal as any).publicationStats;
  if (!isPublicationStats(raw) || !Array.isArray(raw.topInstitutions) || raw.topInstitutions.length === 0) {
    return ""; // 6-20: 缺数据整块跳过(国内刊普遍无, 占位即空洞, 回归测试期望)
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
  // PR #210 (5-22): 砍 OpenAlex 派生 — 引用前10/自引率同源 OpenAlex 抽样, 不准, 关停.
  void journal;
  return "";
}

// ============ 区块 14: 自引率徽章 ============
function renderSelfCitationBadge(journal: JournalInfo): string {
  // PR #227 (5-23): 自引率重启 — 数据源 ablesci (PR #226 清非 ablesci 残留).
  // PR #234 (5-23): 修 580% bug — DB 自引率历史上两种单位并存:
  //   - ablesci 写入: 0-1 ratio (e.g. 0.058)
  //   - LetPub 旧写入: 绝对百分点 (e.g. 5.80, 没归一化)
  //   兼容算法 (同 video/card-generator pctStr): v > 1 视为绝对百分点直用, v ≤ 1 视为 ratio ×100.
  //   边界: v > 100 是脏数据 (人工字段误填等), 不渲染.
  const rate = journal.selfCitationRate;
  if (typeof rate !== "number" || rate <= 0) return "";
  if (rate > 100) {
    console.warn(`[selfCitationRate/shunshi] 越界 rate=${rate}, journal=${journal.name ?? "?"} — 跳过 (PR #234)`);
    return "";
  }
  const pct = rate > 1 ? rate : rate * 100;
  const risk = pct < 5 ? "低" : pct < 15 ? "中" : "高";
  const color = pct < 5 ? "#388E3C" : pct < 15 ? "#F57C00" : "#D32F2F";
  return `<section style="margin:0 0 18px 0;text-align:center;">` +
    `<p style="margin:0 0 4px 0;font-size:13px;color:${MUTED};line-height:1.6;">自引率</p>` +
    `<p style="margin:0;font-size:20px;font-weight:bold;color:${color};line-height:1.4;">${pct.toFixed(1)}% · ${risk}风险</p>` +
    `<p style="margin:4px 0 0 0;font-size:11px;color:${MUTED};line-height:1.5;">数据来源：ablesci</p>` +
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
  const ad = (journal as { acceptanceDifficulty?: string | null }).acceptanceDifficulty || null; // PR #235
  const rc = journal.reviewCycle;
  // PR #146 (5-14): ar+rc 都空才 skip 整块. PR #235: ad 也算"有值".
  if (ar == null && ad == null && rc == null) return "";

  let difficulty = "难度待评估";
  let color = MUTED;
  if (ar != null) {
    if (ar >= 0.45) { difficulty = "录用率较高，相对友好"; color = "#388E3C"; }
    else if (ar >= 0.25) { difficulty = "录用率中等，准备充分可冲"; color = "#F57C00"; }
    else { difficulty = "录用率较低，需高质量稿件"; color = "#D32F2F"; }
  } else if (ad) {
    // PR #235 fallback: ablesci 模糊词 → 同 5 档颜色映射
    if (ad === "容易") { difficulty = `投稿难度：${ad}（ablesci 评级）`; color = "#388E3C"; }
    else if (ad === "较易") { difficulty = `投稿难度：${ad}（ablesci 评级）`; color = "#66BB6A"; }
    else if (ad === "中等") { difficulty = `投稿难度：${ad}（ablesci 评级）`; color = "#F57C00"; }
    else if (ad === "较难") { difficulty = `投稿难度：${ad}（ablesci 评级）`; color = "#E64A19"; }
    else if (ad === "困难" || ad === "极难") { difficulty = `投稿难度：${ad}（ablesci 评级）`; color = "#D32F2F"; }
    else { difficulty = `投稿难度：${ad}（ablesci 评级）`; color = MUTED; }
  }

  const arDisplay = ar != null ? `${(ar * 100).toFixed(0)}%` : (ad ? `${ad}（定性，非精确比例）` : null);
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

  // 中文核心目录 → 国内认可度优势（规则派生, 不复述综合点评）
  const cats = Array.isArray((journal as any).catalogs) ? ((journal as any).catalogs as string[]) : [];
  if ((journal as any).pkuCoreLevel) items.push("北大核心收录，国内职称评审广泛认可");
  if (cats.includes("cssci")) items.push("CSSCI 来源期刊，人文社科高认可度");
  else if (cats.includes("cssci-ext")) items.push("CSSCI 扩展版收录");
  if ((journal as any).cscdLevel) items.push(`CSCD${/核心/.test(String((journal as any).cscdLevel)) ? "核心库" : "扩展库"}收录，自然科学规范认可`);
  if (cats.includes("sci-core")) items.push("中国科技核心（统计源）期刊");

  // AI recommendation 切句补强（仅当无任何规则项时兜底, 避免复述综合点评造成重复）
  if (aiContent.recommendation && items.length === 0) {
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
  // PR #206: 自引率不准 (OpenAlex), 止血 — 删除据 selfCitationRate 输出的风险项 (原"自引率偏高..."提示).
  if (journal.isWarningList) {
    items.push(`已被列入预警名单（${journal.warningYear || "近期"}），慎重投稿`);
  }
  // PR #213: jcarindex 学术诚信风险等级 (中/高) → 避坑项 (规则派生, 数据源 jcarindex 权威)
  const carRaw = (journal as any).carIndexHistory as { source?: string; riskRankText?: string | null } | null;
  if (carRaw?.source === "jcarindex" && (carRaw.riskRankText === "中" || carRaw.riskRankText === "高")) {
    items.push(`jcarindex 学术诚信风险等级「${carRaw.riskRankText}」，投稿前留意论文合规与送审风险`);
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

// ============ 区块 19b: 适合人群画像 (PR #203, 全用可信字段派生) ============
// 帮读者快速"对号入座": 这本刊适合谁、谨慎给谁。仅用 IF/分区/录用率/版面费/审稿/预警 真值,
// 不引入任何新数据。无可派生项则整块 skip。
function renderTargetAudienceBlock(journal: JournalInfo): string {
  const fit: string[] = [];
  const careful: string[] = [];
  const ifv = journal.impactFactor;
  if (typeof ifv === "number") {
    if (ifv >= 10) fit.push("追求高影响力成果、评优青/面上或冲高分文章的团队");
    else if (ifv >= 3) fit.push("常规课题组、有毕业/评职发表需求的硕博");
    else fit.push("起步阶段、需要稳妥发表积累的作者");
  }
  const ar = journal.acceptanceRate;
  if (typeof ar === "number") {
    const pct = ar >= 1 ? ar : ar * 100;
    if (pct >= 40) fit.push("赶毕业、时间紧、希望命中率高一些的作者");
    else if (pct < 25) careful.push("仅有初步结果、稿件完成度不高的作者（录用率偏低）");
  }
  if (journal.reviewCycle && /(1|2|3)\s*(个)?月|fast|快速|周/i.test(journal.reviewCycle)) {
    fit.push("对审稿速度敏感、需要尽快见刊的作者");
  }
  const apc = (journal as any).publicationCosts?.apc ?? journal.apcFee;
  if (typeof apc === "number") {
    if (apc >= 2500) careful.push("经费有限的团队（版面费偏高，需提前确认预算）");
    else if (apc === 0) fit.push("经费有限但希望开放获取的作者（无版面费）");
  }
  if (journal.isWarningList) {
    careful.push("单位/基金有 SCI 硬性考核要求的作者（该刊在预警名单中）");
  }
  if (fit.length === 0 && careful.length === 0) return "";

  const renderList = (arr: string[], mark: string, c: string) =>
    arr.map((t) => `<p style="margin:0 0 6px 0;font-size:14px;line-height:1.7;color:${TEXT};">${mark} ${esc(t)}</p>`).join("");
  let body = "";
  if (fit.length > 0) body += `<p style="margin:0 0 4px 0;font-size:14px;font-weight:600;color:#388E3C;">适合投：</p>` + renderList(fit, "·", "#388E3C");
  if (careful.length > 0) body += `<p style="margin:10px 0 4px 0;font-size:14px;font-weight:600;color:#F57C00;">谨慎评估：</p>` + renderList(careful, "·", "#F57C00");
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">👥 适合人群</p>` +
    body +
    `</section>`;
}

// ============ 区块 19c: 投稿时间线 (PR #203, 由审稿周期/刊期派生) ============
// 把"投稿→初审→录用→见刊"画成预期时间线。仅用 reviewCycle + frequency 真值, 无审稿周期则 skip。
function renderTimelineBlock(journal: JournalInfo): string {
  // 老韩 6-15: 无审稿周期也渲染时间线结构, 该步诚实标注"暂无"(原整块 skip)
  // 6-16 手机端: 审稿周期值常是长句(如"网友分享经验：平均3.0个月"), 窄屏格子塞不下 → 抽取核心时长压缩
  const rc = journal.reviewCycle;
  let rcSub = "周期待定";
  if (rc) {
    const m = rc.match(/(\d+(?:\.\d+)?)\s*(个?月|周|w|天)/i);
    rcSub = m ? esc(`约${m[1]}${m[2]}`) : esc(rc.length > 8 ? rc.slice(0, 8) + "…" : rc);
  }
  const rawStats = (journal as any).publicationStats;
  const freq = isPublicationStats(rawStats) && typeof rawStats.frequency === "string" ? rawStats.frequency : (journal.frequency || null);
  const steps: Array<{ label: string; sub: string }> = [
    { label: "投稿", sub: "提交系统" },
    { label: "初审 / 外审", sub: rcSub },
    { label: "录用", sub: "完成修回后" },
    { label: "见刊", sub: freq ? `刊期 ${esc(freq)}` : "排版上线" },
  ];
  const cells = steps.map((st, i) =>
    `<td style="text-align:center;vertical-align:top;padding:0 4px;">` +
    `<div style="width:22px;height:22px;line-height:22px;margin:0 auto 6px auto;border-radius:50%;background:${BLUE};color:#fff;font-size:12px;font-weight:bold;">${i + 1}</div>` +
    `<p style="margin:0;font-size:13px;font-weight:600;color:${TEXT};line-height:1.4;">${esc(st.label)}</p>` +
    `<p style="margin:2px 0 0 0;font-size:12px;color:${MUTED};line-height:1.4;">${st.sub}</p>` +
    `</td>`,
  ).join('<td style="vertical-align:top;padding-top:4px;color:#BBB;font-size:14px;">→</td>');
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#F5F9FF;border-radius:6px;">` +
    `<p style="margin:0 0 12px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">🗓️ 投稿时间线（预期）</p>` +
    `<table style="width:100%;border-collapse:collapse;"><tr>${cells}</tr></table>` +
    `<p style="margin:10px 0 0 0;font-size:12px;color:${MUTED};line-height:1.6;">* 时间线为基于审稿周期/刊期的预期参考，实际以期刊系统进度为准。</p>` +
    `</section>`;
}

// ============ 区块 19d: 同档期刊对比 (PR #203, 池内同分区/同学科 IF 相近) ============
// 给读者一个"横向参照": 同档位还有哪些选择, 各自 IF/录用率/版面费如何。全用可信字段, 无 peer 则 skip。
function renderPeerComparisonBlock(journal: JournalInfo): string {
  const peers = journal.peerJournals;
  if (!peers || peers.length === 0) return renderMissingDataBlock("同档期刊对比"); // 老韩 6-15: 占位补满(原隐藏)
  const fmtIF = (v: number | null) => (typeof v === "number" && v > 0 ? v.toFixed(1) : "—"); // PR #209: IF<=0 占位值显示 —
  const fmtAR = (v: number | null) => (typeof v === "number" ? `${(v >= 1 ? v : v * 100).toFixed(0)}%` : "—");
  const fmtAPC = (v: number | null) => (typeof v === "number" ? (v === 0 ? "免费" : `$${v}`) : "—");
  const th = (t: string) => `<th style="padding:6px 8px;font-size:12px;color:${MUTED};font-weight:600;text-align:left;border-bottom:1px solid #E0E0E0;">${t}</th>`;
  const td = (t: string, bold = false) => `<td style="padding:6px 8px;font-size:13px;color:${TEXT};border-bottom:1px solid #F0F0F0;${bold ? "font-weight:600;" : ""}">${t}</td>`;
  const rowSelf =
    `<tr style="background:#F5F9FF;">` + td(`${esc(journal.nameEn || journal.name)}（本刊）`, true) + td(fmtIF(journal.impactFactor)) + td(fmtAR(journal.acceptanceRate)) + td(fmtAPC((journal as any).apcFee ?? null)) + `</tr>`;
  const rowsPeer = peers
    .map((pj) => `<tr>` + td(esc(pj.nameEn || pj.name)) + td(fmtIF(pj.impactFactor)) + td(fmtAR(pj.acceptanceRate)) + td(fmtAPC(pj.apcFee)) + `</tr>`)
    .join("");
  return `<section style="margin:0 0 22px 0;padding:14px 16px;background:#FAFAFA;border-radius:6px;">` +
    `<p style="margin:0 0 12px 0;font-size:16px;font-weight:bold;color:${BLUE};line-height:1.5;">📋 同档期刊对比</p>` +
    `<table style="width:100%;border-collapse:collapse;"><thead><tr>${th("期刊")}${th("IF")}${th("录用率")}${th("版面费")}</tr></thead>` +
    `<tbody>${rowSelf}${rowsPeer}</tbody></table>` +
    `<p style="margin:10px 0 0 0;font-size:12px;color:${MUTED};line-height:1.6;">* 同分区/同学科、影响因子相近的期刊参照，数据均来自权威源；"—"表示该项暂无公开数据。</p>` +
    `</section>`;
}

// ============ PR #205: 版式差异化 — 编辑型板块簇确定性重排 ============
// 用期刊 ISSN/刊名做种子, 同一刊顺序稳定可复现, 不同刊顺序不同 → 多篇文章不雷同.
// 只重排"编辑型/分析型"次级板块, 核心可信块(题图/IF/JCR)保持置顶不动.
function journalLayoutSeed(journal: JournalInfo): number {
  const str = journal.issn || journal.nameEn || journal.name || "x";
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  return h || 1;
}
function seededOrder<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = seed || 1;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff; // LCG 确定性
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

  // 公众号丰富版 (老韩 6-14 拍板恢复): 恢复 PR-Q1 砍掉的价值模块, 但保留两处去重修复 ——
  //   (1) 审稿周期仍只在推荐指数块出现一次; (2) 风险仍只由 CAR 块发声。
  //   唯一仍不恢复的是派生投稿建议块 renderSubmissionAdviceBlock(它同时是审稿周期重复展示 + "预警名单安全"矛盾源)。
  const wrapChart = (svg: string) => svg ? `<section style="margin:0 0 18px 0;padding:8px 0;">${svg}</section>` : "";

  sections.push(renderHeroBlock(journal));                            //  1 封面/品牌头
  sections.push(renderBasicInfoBlock(journal));                       //  2 ISSN/出版商
  // 6-17: 国内刊(无 WoS 信号)跳过 JCR/IF/CAR 这些 SCI 专属版块, 否则满屏占位空洞。
  const wos = hasWosData(journal);
  if (!wos) sections.push(renderDomesticCredentialBlock(journal));    //  6-20 国内刊凭证主角(替代分区徽章)
  if (wos) sections.push(renderJcrQuartileBlock(journal));            //  3 分区
  if (wos) sections.push(renderIfHistoryChart(journal));              //  4 IF 趋势图
  if (wos) sections.push(renderImpactFactorBlock(journal));          //  5 IF
  if (wos) sections.push(renderCarHistoryBlock(journal));            //  6 风险(唯一风险发声处)
  sections.push(renderJcrFullPanel(journal));                         //  7 JCR 完整面板
  sections.push(renderScopeDetailsBlock(journal));                    //  8 收稿范围
  sections.push(renderPublicationCostsBlock(journal));                //  9 版面费
  sections.push(renderFrequencyBlock(journal));                       // 10 出版频率
  sections.push(renderAnnualVolumeChart(journal)); // 11 发文量图(6-20: 缺数据跳过)
  sections.push(renderTopInstitutionsBlock(journal));                 // 12 TopN 机构
  if (typesSet.has("citing-pie")) sections.push(renderCitingJournalsPie(journal)); // 13 引用来源饼
  // 老韩6-15: 录用率/版面费/审稿周期图去门控 always 渲染(各函数空数据返回"", 有数据才出图; 如 APC 存在→版面费饼真出图)
  sections.push(wrapChart(renderAcceptRateBarChart(journal.acceptanceRate ?? null)));
  sections.push(wrapChart(renderFeePieChart(journal.apcFee ?? null)));
  sections.push(wrapChart(renderReviewCycleBarChart(journal.reviewCycle ?? null)));
  sections.push(renderSelfCitationBadge(journal));                    // 14 自引徽章
  sections.push(renderRecommendationScoreBlock(journal));             // 15 推荐指数+审稿周期(审稿周期唯一出现处)
  if (wos) sections.push(renderIfHistoryAnalysis(aiContent));         // 15a IF 历史深度分析(仅国外刊)
  if (wos) sections.push(renderCarRiskAnalysis(aiContent));           // 15b CAR 风险深度分析(仅国外刊)
  sections.push(renderScopeAndCitations(aiContent));                  // 15c 收稿范围+引用深度分析
  sections.push(renderAiSubmissionAdvice(aiContent));                 // 15d 投稿建议(唯一, 派生重复块不恢复)
  sections.push(renderSummaryBlock(aiContent));                       // 16 综合点评(一句话总评)
  // 编辑型板块簇按期刊种子确定性重排, 多篇文章版式不雷同
  const editorialCluster = seededOrder([
    renderAdvantagesBlock(journal, aiContent),    // 优势
    renderCautionsBlock(journal, aiContent),      // 注意
    renderTargetAudienceBlock(journal),           // 适合人群
    renderTimelineBlock(journal),                 // 投稿时间线
    renderPeerComparisonBlock(journal),           // 同档对比
  ], journalLayoutSeed(journal));
  for (const blk of editorialCluster) sections.push(blk);
  sections.push(renderMarketingCtaBlock(journal));                    // 投稿协助 CTA
  sections.push(renderContactBlock(tenant));                          // 联系方式
  sections.push(renderDisclaimerBlock());                             // 免责
  sections.push(renderFooterBlock(journal));                          // 页脚

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
