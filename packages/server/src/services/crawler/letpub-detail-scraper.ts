/**
 * LetPub 期刊详情页数据抓取器
 *
 * 从 LetPub 详情页抓取用于文章插图的结构化数据：
 * 1. 近10年影响因子历史（用于生成趋势柱状图）
 * 2. 近10年发文量历史（用于生成发文量柱状图）
 * 3. 期刊分区详情（新锐分区、中科院分区、JCR/JCI 分区表）
 * 4. 期刊官网 banner 截图 URL
 * 5. 学科分布数据
 *
 * LetPub 详情页 URL：
 * https://www.letpub.com.cn/index.php?page=journalapp&view=detail&journalid={ID}
 *
 * 也可通过搜索获取：
 * POST https://www.letpub.com.cn/index.php?page=journalapp&view=search
 */

import { logger } from "../../config/logger.js";
import { ProxyAgent } from "undici";

const LETPUB_BASE = "https://www.letpub.com.cn";

// PR #189 (5-20): enrich 详情爬代理支持 — LetPub 封 IP 时, env LETPUB_PROXY 设代理 URL,
//   走代理新 IP 绕过封禁 (方案 C 补 IF/分区/录用率 的前提). 模块级单例 dispatcher.
const LETPUB_PROXY = process.env.LETPUB_PROXY;
const proxyDispatcher = LETPUB_PROXY ? new ProxyAgent(LETPUB_PROXY) : undefined;
if (LETPUB_PROXY) logger.info({ proxy: LETPUB_PROXY.replace(/:[^:@]*@/, ":***@") }, "PR #189 LetPub 详情爬启用代理");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ============ 类型 ============

export interface LetPubJournalDetail {
  /** 影响因子历年数据：{ year: number, value: number }[] */
  ifHistory: Array<{ year: number; value: number }>;

  /** 发文量历年数据：{ year: number, count: number }[] */
  pubVolumeHistory: Array<{ year: number; count: number }>;

  /** 中科院分区详情 */
  casPartitions: Array<{
    version: string;       // "2026年新锐分区" / "中科院2025年分区"
    publishDate?: string;  // "2026年3月24日发布"
    majorCategory: string; // "1区 医学"
    subCategories: Array<{
      zone: string;        // "1区"
      subject: string;     // "肿瘤学 ONCOLOGY"
    }>;
    isTop: boolean;        // TOP期刊
    isReview: boolean;     // 综述期刊
  }>;

  /** JCR 学科分区 */
  jcrPartitions: Array<{
    subject: string;       // "HEMATOLOGY"
    database: string;      // "SCIE"
    zone: string;          // "Q1"
    rank: string;          // "6/98"
  }>;

  /** JCI 学科分区 */
  jciPartitions: Array<{
    subject: string;
    database: string;
    zone: string;
    rank: string;
  }>;

  /** 封面图 URL（如果找到） */
  coverImageUrl: string | null;

  /** 官网 banner 截图 URL（通常是出版商网站截图） */
  websiteBannerUrl: string | null;
}

// ============ 主抓取函数 ============

/**
 * 从 LetPub 搜索并抓取期刊详情数据
 */
// 7-02: LetPub 抓取分类结果 — 供断路器分级(only "blocked" 计入 5 连败)。
export type LetPubFetchOutcome =
  | { kind: "ok"; detail: LetPubJournalDetail }
  | { kind: "not_found" }                       // 正常返回页面但无匹配 = 自然查无(不计熔断)
  | { kind: "blocked"; reason: string };        // HTTP异常/超时/解析异常页 = 反爬信号(计入)

/**
 * 分类版抓取: 返回 ok/not_found/blocked。断路器只对 blocked 计数。
 * 自然查无(not_found)不计入连败, 可继续; 真反爬(blocked)才累加。
 */
export async function scrapeLetPubDetailClassified(
  journalName: string,
  issn?: string
): Promise<LetPubFetchOutcome> {
  const page = await fetchLetPubDetailPage(journalName, issn);
  if (page.kind === "blocked") {
    logger.warn({ journalName, reason: page.reason }, "LetPub 抓取被拦(反爬信号, 计入熔断)");
    return page;
  }
  if (page.kind === "not_found") {
    logger.info({ journalName, issn }, "LetPub adapter: 期刊未找到(自然查无, 不计熔断)");
    return { kind: "not_found" };
  }
  // page.kind === "page" — 拿到详情页, 解析
  try {
    const result: LetPubJournalDetail = {
      ifHistory: parseIFHistory(page.html),
      pubVolumeHistory: parsePubVolumeHistory(page.html),
      casPartitions: parseCASPartitions(page.html),
      jcrPartitions: parseJCRPartitions(page.html),
      jciPartitions: parseJCIPartitions(page.html),
      coverImageUrl: parseCoverImage(page.html),
      websiteBannerUrl: null, // TODO: 从期刊官网抓取
    };
    logger.info(
      {
        journalName,
        ifYears: result.ifHistory.length,
        pubYears: result.pubVolumeHistory.length,
        casPartitions: result.casPartitions.length,
        jcrPartitions: result.jcrPartitions.length,
      },
      "LetPub 详情数据抓取成功"
    );
    return { kind: "ok", detail: result };
  } catch (err) {
    // 拿到页面却解析失败 → 疑似异常页/验证码页, 归为反爬信号
    logger.warn({ journalName, error: String(err) }, "LetPub 详情解析异常(疑似异常页, 计入熔断)");
    return { kind: "blocked", reason: "parse: " + String(err) };
  }
}

/** 原签名 (月度 cron 等旧调用方保持不变): 只要 detail, blocked/not_found 都塌成 null。 */
export async function scrapeLetPubDetail(
  journalName: string,
  issn?: string
): Promise<LetPubJournalDetail | null> {
  const r = await scrapeLetPubDetailClassified(journalName, issn);
  return r.kind === "ok" ? r.detail : null;
}

// ============ 页面获取 ============

/** 带重试的 fetch（复用于 LetPub 搜索和详情页） */
async function fetchWithRetryLetPub(
  url: string,
  init: RequestInit,
  retries = 1
): Promise<Response | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      // PR #189: 有 LETPUB_PROXY 时走代理 dispatcher (undici 扩展, RequestInit 类型不含, as any)
      const resp = await fetch(url, {
        ...init,
        signal: controller.signal,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      } as RequestInit & { dispatcher?: unknown });
      clearTimeout(timeout);
      if (resp.ok) return resp;
      logger.debug({ url, status: resp.status, attempt: i + 1 }, "LetPub 请求非200");
    } catch (err) {
      logger.debug({ url, err: String(err), attempt: i + 1 }, "LetPub 请求失败");
      if (i < retries) await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }
  }
  return null;
}

/**
 * 检测搜索结果页是否为"0 结果"。
 * 用于防御性早返回，避免 fallback 把 0-results 错误页伪装成详情页。
 * Exported for unit testing.
 *
 * task #44 (BMJ 0959-8138)：LetPub 库不收录某些 ISSN 时返回**裸 search 表单**响应
 * （HTTP 200，~75KB，仅含 form + 页眉 chrome），无标准 `搜索条件匹配 0 条记录` 标记。
 * 兜底特征：(a) 无 `journalid=N` (b) 无 `view=detail` link (c) `<tr>` < 20。
 */
export function isZeroResultsSearchPage(html: string): boolean {
  if (/搜索条件匹配[：:]\s*0条记录|暂无匹配结果/.test(html)) return true;
  // BMJ-style 裸表单兜底（数据源边界，task #44）
  // 仅在 html 是 LetPub search 响应（含 searchissn 表单字段）时才走兜底，
  // 避免随便的小 HTML 被误判。
  const isLetPubSearchResponse = /name=["']?searchissn["']?/i.test(html);
  if (!isLetPubSearchResponse) return false;
  const hasJournalIdLink = /journalid=\d+/.test(html);
  const hasDetailLink = /view=detail/.test(html);
  const trCount = (html.match(/<tr\b/g) || []).length;
  return !hasJournalIdLink && !hasDetailLink && trCount < 20;
}

/**
 * 从搜索结果 HTML 提取第一个非 0 的 journalid。
 * 容忍 URL 参数顺序变化（不再依赖 href 严格匹配 page=journalapp&view=detail&journalid=X）。
 * Exported for unit testing.
 */
export function extractJournalIdFromSearchHtml(html: string): string | null {
  const matches = html.matchAll(/journalid=([1-9]\d*)/g);
  for (const m of matches) {
    return m[1];
  }
  return null;
}

/**
 * Bug B.2.1.A.4 修：LetPub 对 searchname+searchissn 做 AND 匹配 —
 * "The Lancet"+0140-6736 命中 0 条（库内 searchname="Lancet" 无 The 前缀）。
 * ISSN 已是唯一键，issn 在场时只发 ISSN，避免名称模糊匹配。
 * Exported for unit testing.
 */
export function buildLetPubSearchFormData(
  journalName: string | null,
  issn: string | null,
): URLSearchParams | null {
  if (!issn && !journalName) return null;
  return new URLSearchParams({
    searchname: issn ? "" : (journalName ?? ""),
    searchissn: issn ?? "",
    searchfield: "",
    searchsort: "",
    searchsortorder: "desc",
    searchimpactlow: "",
    searchimpacthigh: "",
    currentsearchpage: "1",
  });
}

// 7-02: 页面获取分类结果 — page(拿到详情页) / not_found(正常返回但无匹配=自然查无) / blocked(HTTP异常/超时=反爬信号)。
type LetPubPageResult =
  | { kind: "page"; html: string }
  | { kind: "not_found" }
  | { kind: "blocked"; reason: string };

async function fetchLetPubDetailPage(
  journalName: string,
  issn?: string
): Promise<LetPubPageResult> {
  const formData = buildLetPubSearchFormData(journalName || null, issn || null);
  if (!formData) {
    logger.debug({ journalName, issn }, "LetPub: 缺 issn 与 journalName，跳过");
    return { kind: "not_found" }; // 无搜索键 = 无从匹配, 属自然查无(非反爬)
  }
  const searchUrl = `${LETPUB_BASE}/index.php?page=journalapp&view=search`;

  try {
    const searchResp = await fetchWithRetryLetPub(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Referer: `${LETPUB_BASE}/index.php?page=journalapp`,
        Accept: "text/html",
      },
      body: formData.toString(),
    });
    if (!searchResp) return { kind: "blocked", reason: "search 页 fetch 失败(HTTP非200/超时/网络)" }; // 拿不到页 = 反爬信号

    const searchHtml = await searchResp.text();

    // 0-results 早返回（防御 fallback 误把错误页当详情页）— 正常返回页面但无结果 = 自然查无
    if (isZeroResultsSearchPage(searchHtml)) {
      logger.debug({ journalName, issn }, "LetPub: 0 search results");
      return { kind: "not_found" };
    }

    // 提取 journalid（容忍参数顺序 + 不依赖 href 包装）— 返回页面但无 id = 自然查无
    const journalId = extractJournalIdFromSearchHtml(searchHtml);
    if (!journalId) {
      logger.debug({ journalName, issn }, "LetPub: journalid 提取失败");
      return { kind: "not_found" };
    }

    // 自己拼详情 URL（不再"返回搜索页伪装详情页"的危险 fallback）
    const detailUrl = `${LETPUB_BASE}/index.php?journalid=${journalId}&page=journalapp&view=detail`;
    const detailResp = await fetchWithRetryLetPub(detailUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: searchUrl,
        Accept: "text/html",
      },
    });
    if (!detailResp) return { kind: "blocked", reason: "detail 页 fetch 失败(有id却拿不到, 反爬信号)" }; // 有 id 却拿不到详情 = 反爬

    return { kind: "page", html: await detailResp.text() };
  } catch (err) {
    logger.debug({ journalName, err: String(err) }, "LetPub 页面获取失败");
    return { kind: "blocked", reason: String(err) }; // 异常 = 反爬信号
  }
}

// ============ 数据解析（PR #30: ECharts 适配重写） ============

/**
 * 通用：从 ECharts option 字面量按 series.name 提取年-值序列。
 *
 * 现 LetPub 详情页用 ECharts（不是 Highcharts）渲染图表。结构示例：
 *   xAxis : [{ type:'category', data: ['2015-2016年度', ..., '2024-2025年度'] }]
 *   series : [{ name:'IF值', data: [44.002, 47.831, ...] }]
 *
 * 年份取每个 'YYYY-YYYY年度' 的第一个 4 位数（"2024-2025年度" → 2024）。
 * Exported for unit testing.
 */
export function parseEChartsLineChart(
  html: string,
  seriesName: string,
): Array<{ year: number; value: number }> {
  const escName = seriesName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const seriesIdx = html.search(new RegExp(`name\\s*:\\s*['"]${escName}['"]`));
  if (seriesIdx === -1) return [];
  // 向前回看找最近 xAxis ... data : [...]
  const before = html.slice(Math.max(0, seriesIdx - 5000), seriesIdx);
  const xMatches = [...before.matchAll(/xAxis\s*:\s*\[\s*\{[\s\S]*?data\s*:\s*\[([^\]]+)\]/g)];
  if (xMatches.length === 0) return [];
  const years = [...xMatches[xMatches.length - 1][1].matchAll(/['"](\d{4})/g)].map((m) =>
    parseInt(m[1], 10),
  );
  // series.name 后第一个 data : [...]（series 内的）
  const after = html.slice(seriesIdx, seriesIdx + 2000);
  const dataMatch = after.match(/data\s*:\s*\[([\d.,\s-]+)\]/);
  if (!dataMatch) return [];
  const values = dataMatch[1]
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((v) => !isNaN(v));
  const out: Array<{ year: number; value: number }> = [];
  for (let i = 0; i < Math.min(years.length, values.length); i++) {
    if (values[i] > 0) out.push({ year: years[i], value: values[i] });
  }
  return out;
}

/** 影响因子历年（ECharts 'IF值' 系列） */
export function parseIFHistory(html: string): Array<{ year: number; value: number }> {
  return parseEChartsLineChart(html, "IF值");
}

/** 发文量历年（ECharts '年文章数' 系列） */
export function parsePubVolumeHistory(html: string): Array<{ year: number; count: number }> {
  return parseEChartsLineChart(html, "年文章数").map((r) => ({
    year: r.year,
    count: Math.round(r.value),
  }));
}

/**
 * 中科院/新锐分区。每个版本单独一张 4 列表：大类学科 / 小类学科 / Top期刊 / 综述期刊。
 * 版本 anchor 形如：《新锐期刊分区表》(YYYY年M月发布) / 期刊分区表 (YYYY年M月升级版|基础版|旧的升级版)
 * Exported for unit testing.
 */
export function parseCASPartitions(html: string): LetPubJournalDetail["casPartitions"] {
  const result: LetPubJournalDetail["casPartitions"] = [];
  // 每个分区版本一个 anchor（《新锐期刊分区表》/ 期刊分区表 + YYYY年M月 + suffix）
  const anchors = [
    ...html.matchAll(
      /(《新锐期刊分区表》|期刊分区表)[\s\S]{0,200}?(\d{4})年(\d{1,2})月(旧的升级版|旧的基础版|升级版|基础版|发布)/g,
    ),
  ];
  for (let i = 0; i < anchors.length; i++) {
    const m = anchors[i];
    const start = m.index!;
    const end = i + 1 < anchors.length ? anchors[i + 1].index! : Math.min(html.length, start + 6000);
    const chunk = html.slice(start, end);
    if (!chunk.includes("大类学科")) continue;
    // 大类：4 列 header 后第一个数据行的 <td>NAME <span>X区</span>
    const major = chunk.match(
      /综述期刊\s*<\/th>\s*<\/tr>\s*<tr[^>]*>\s*<td[^>]*>\s*([^<\s][^<]*?)\s*<span[^>]*>\s*(\d区)/,
    );
    if (!major) continue;
    // 小类：嵌套子表里的行（subject 大写英文 + 可选中文 br + 区号）
    const subs = [
      ...chunk.matchAll(
        /<td[^>]*>\s*([A-Z][A-Z0-9 ,&\-/]+?)(?:\s*<br[^>]*>\s*([^<]+?))?\s*<\/td>[\s\S]{0,200}?<span[^>]*>\s*(\d区)/g,
      ),
    ].map((s) => ({
      subject: s[2] ? `${s[1].trim()}（${s[2].trim()}）` : s[1].trim(),
      zone: s[3],
    }));
    // Top期刊 + 综述期刊：嵌套子表之后两个 td
    const tail = chunk.match(
      /<\/table>\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/,
    );
    const isTop = (tail?.[1] ?? "").trim() === "是";
    const isReview = (tail?.[2] ?? "").trim() === "是";
    result.push({
      version: `${m[1].replace(/《|》/g, "")} ${m[2]}年${m[3]}月${m[4]}`,
      publishDate: `${m[2]}年${m[3]}月`,
      majorCategory: `${major[2]} ${major[1].trim()}`,
      subCategories: subs,
      isTop,
      isReview,
    });
  }
  return result;
}

/**
 * 通用：从 "按 X 指标学科分区" 表提取 4 列结构（学科 / 收录子集 / 分区 / 排名）。
 * Exported for unit testing.
 */
export function parseQuartileTable(
  html: string,
  anchor: "JIF" | "JCI",
): Array<{ subject: string; database: string; zone: string; rank: string }> {
  const headerRe = new RegExp(`按${anchor}指标学科分区[\\s\\S]*?<\\/table>`, "i");
  const section = html.match(headerRe);
  if (!section) return [];
  const result: Array<{ subject: string; database: string; zone: string; rank: string }> = [];
  // 数据行：<td>学科：NAME</td><td>SCIE</td><td>Q1</td><td>1/332</td>...
  const rowRe = /<tr[^>]*>\s*<td[^>]*>\s*(?:学科[：:]\s*)?([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*(Q[1-4])\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/gi;
  for (const m of section[0].matchAll(rowRe)) {
    const subject = m[1].trim();
    const database = m[2].trim();
    const zone = m[3].trim().toUpperCase();
    const rank = m[4].trim();
    if (subject && /^Q[1-4]$/.test(zone)) {
      result.push({ subject, database, zone, rank });
    }
  }
  return result;
}

/** JCR 分区（按 JIF 指标学科分区） */
export function parseJCRPartitions(html: string): LetPubJournalDetail["jcrPartitions"] {
  return parseQuartileTable(html, "JIF");
}

/** JCI 分区（按 JCI 指标学科分区） */
export function parseJCIPartitions(html: string): LetPubJournalDetail["jciPartitions"] {
  return parseQuartileTable(html, "JCI");
}

/**
 * 解析封面图
 */
function parseCoverImage(html: string): string | null {
  const coverPatterns = [
    /src="((?:https?:\/\/[^"]*)?journalcover\/[^"]+)"/i,
    /src="((?:https?:\/\/[^"]*)?journal_cover\/[^"]+)"/i,
    /src="((?:https?:\/\/[^"]*)?cover[^"]*\.(?:jpg|png|gif|webp))"/i,
  ];

  for (const pattern of coverPatterns) {
    const match = html.match(pattern);
    if (match) {
      let url = match[1];
      if (!url.startsWith("http")) {
        url = `${LETPUB_BASE}/${url.replace(/^\//, "")}`;
      }
      return url;
    }
  }

  return null;
}
