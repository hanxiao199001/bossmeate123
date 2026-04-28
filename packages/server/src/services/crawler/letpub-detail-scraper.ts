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

const LETPUB_BASE = "https://www.letpub.com.cn";
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
export async function scrapeLetPubDetail(
  journalName: string,
  issn?: string
): Promise<LetPubJournalDetail | null> {
  try {
    // 第一步：通过搜索找到期刊详情页
    const detailHtml = await fetchLetPubDetailPage(journalName, issn);
    if (!detailHtml) {
      logger.warn({ journalName }, "LetPub 详情页未找到");
      return null;
    }

    // 第二步：解析各项数据（PR #30 后 parsers 直接读 ECharts，不再需要 guard 兜底）
    const result: LetPubJournalDetail = {
      ifHistory: parseIFHistory(detailHtml),
      pubVolumeHistory: parsePubVolumeHistory(detailHtml),
      casPartitions: parseCASPartitions(detailHtml),
      jcrPartitions: parseJCRPartitions(detailHtml),
      jciPartitions: parseJCIPartitions(detailHtml),
      coverImageUrl: parseCoverImage(detailHtml),
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

    return result;
  } catch (err) {
    logger.warn({ journalName, error: String(err) }, "LetPub 详情抓取失败");
    return null;
  }
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
      const resp = await fetch(url, { ...init, signal: controller.signal });
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
 */
export function isZeroResultsSearchPage(html: string): boolean {
  return /搜索条件匹配[：:]\s*0条记录|暂无匹配结果/.test(html);
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

async function fetchLetPubDetailPage(
  journalName: string,
  issn?: string
): Promise<string | null> {
  const formData = buildLetPubSearchFormData(journalName || null, issn || null);
  if (!formData) {
    logger.debug({ journalName, issn }, "LetPub: 缺 issn 与 journalName，跳过");
    return null;
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
    if (!searchResp) return null;

    const searchHtml = await searchResp.text();

    // 0-results 早返回（防御 fallback 误把错误页当详情页）
    if (isZeroResultsSearchPage(searchHtml)) {
      logger.debug({ journalName, issn }, "LetPub: 0 search results");
      return null;
    }

    // 提取 journalid（容忍参数顺序 + 不依赖 href 包装）
    const journalId = extractJournalIdFromSearchHtml(searchHtml);
    if (!journalId) {
      logger.debug({ journalName, issn }, "LetPub: journalid 提取失败");
      return null;
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
    if (!detailResp) return null;

    return await detailResp.text();
  } catch (err) {
    logger.debug({ journalName, err: String(err) }, "LetPub 页面获取失败");
    return null;
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
