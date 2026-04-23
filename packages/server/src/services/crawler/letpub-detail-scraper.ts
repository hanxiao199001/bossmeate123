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

    // 第二步：解析各项数据
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

async function fetchLetPubDetailPage(
  journalName: string,
  issn?: string
): Promise<string | null> {
  // 搜索期刊
  const searchUrl = `${LETPUB_BASE}/index.php?page=journalapp&view=search`;
  const formData = new URLSearchParams({
    searchname: journalName,
    searchissn: issn || "",
    searchfield: "",
    searchopen: "",
    searchsub: "",
    searchletter: "",
    searchsort: "relevance",
    searchimpactlow: "",
    searchimpacthigh: "",
    currentpage: "1",
  });

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

    // 提取详情页链接
    const detailMatch = searchHtml.match(
      /href="(index\.php\?page=journalapp&view=detail&journalid=[^"]+)"/
    );

    if (!detailMatch) {
      // 搜索结果页可能就是详情页（如果只有一个结果）
      if (searchHtml.includes("影响因子") || searchHtml.includes("Impact Factor")) {
        return searchHtml;
      }
      return null;
    }

    // 访问详情页（带重试）
    const detailUrl = `${LETPUB_BASE}/${detailMatch[1]}`;
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

// ============ 数据解析 ============

/**
 * 解析影响因子历年数据
 *
 * LetPub 页面中 IF 趋势数据通常在 JavaScript 变量或 table 中：
 * - Highcharts: categories: ['2015','2016',...], data: [3.492, 5.133, ...]
 * - 或在表格行中
 */
function parseIFHistory(html: string): Array<{ year: number; value: number }> {
  const result: Array<{ year: number; value: number }> = [];

  // 方式1: Highcharts categories + data 配对
  // categories: ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024']
  const catMatch = html.match(/categories\s*:\s*\[([^\]]+)\]/);
  // data: [3.492, 5.133, 8.593, 10.9, 9.4, 13.5]
  const dataMatch = html.match(/data\s*:\s*\[([0-9.,\s]+)\]/);

  if (catMatch && dataMatch) {
    const years = catMatch[1].match(/\d{4}/g) || [];
    const values = dataMatch[1].split(",").map((v) => parseFloat(v.trim()));

    for (let i = 0; i < Math.min(years.length, values.length); i++) {
      if (!isNaN(values[i]) && values[i] > 0) {
        result.push({ year: parseInt(years[i]), value: values[i] });
      }
    }
    if (result.length > 0) return result;
  }

  // 方式2: 表格行 <td>2024</td><td>13.5</td>
  const yearValuePairs = html.matchAll(
    /(\d{4})\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/gi
  );
  for (const m of yearValuePairs) {
    const year = parseInt(m[1]);
    const value = parseFloat(m[2]);
    if (year >= 2010 && year <= 2030 && value > 0 && value < 500) {
      result.push({ year, value });
    }
  }

  // 方式3: 用正则匹配 "影响因子" 相关的年份-数值对
  const ifSection = html.match(/影响因子[^]*?(?=<\/table>|<\/div>\s*<div)/i);
  if (ifSection) {
    const pairs = ifSection[0].matchAll(
      /(?:20[12]\d)\D+([\d.]+)/g
    );
    for (const p of pairs) {
      const year = parseInt(p[0].match(/20[12]\d/)![0]);
      const value = parseFloat(p[1]);
      if (value > 0 && value < 500) {
        result.push({ year, value });
      }
    }
  }

  // 去重并按年份排序
  const seen = new Set<number>();
  return result
    .filter((r) => {
      if (seen.has(r.year)) return false;
      seen.add(r.year);
      return true;
    })
    .sort((a, b) => a.year - b.year);
}

/**
 * 解析发文量历年数据
 */
function parsePubVolumeHistory(html: string): Array<{ year: number; count: number }> {
  const result: Array<{ year: number; count: number }> = [];

  // Highcharts 发文量图表数据
  // 通常和 IF 图表在同一页面但不同的 chart 配置中
  // 找 "发文量" 或 "articles" 相关的 chart data
  const pubSection = html.match(/发文[量情][^]*?data\s*:\s*\[([0-9.,\s]+)\]/i);
  if (pubSection) {
    const catMatch = html.match(
      /发文[量情][^]*?categories\s*:\s*\[([^\]]+)\]/i
    );
    if (catMatch) {
      const years = catMatch[1].match(/\d{4}/g) || [];
      const counts = pubSection[1].split(",").map((v) => parseInt(v.trim()));
      for (let i = 0; i < Math.min(years.length, counts.length); i++) {
        if (!isNaN(counts[i]) && counts[i] > 0) {
          result.push({ year: parseInt(years[i]), count: counts[i] });
        }
      }
      if (result.length > 0) return result;
    }
  }

  // 表格方式
  const pubTableSection = html.match(
    /(?:发文量|Article\s*Count|年发文)[^]*?<\/table>/i
  );
  if (pubTableSection) {
    const pairs = pubTableSection[0].matchAll(
      /(\d{4})\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/gi
    );
    for (const m of pairs) {
      result.push({ year: parseInt(m[1]), count: parseInt(m[2]) });
    }
  }

  const seen = new Set<number>();
  return result
    .filter((r) => {
      if (seen.has(r.year)) return false;
      seen.add(r.year);
      return true;
    })
    .sort((a, b) => a.year - b.year);
}

/**
 * 解析中科院分区数据
 */
function parseCASPartitions(html: string): LetPubJournalDetail["casPartitions"] {
  const result: LetPubJournalDetail["casPartitions"] = [];

  // 匹配 "新锐分区" / "中科院XXX年分区" 块
  const casBlocks = html.matchAll(
    /((?:新锐|中科院)\d{4}年分区[^]*?)(?=(?:新锐|中科院)\d{4}年分区|JCR分区|WOS|$)/gi
  );

  for (const block of casBlocks) {
    const text = block[1];
    const versionMatch = text.match(/((?:新锐|中科院)\d{4}年分区)/);
    const dateMatch = text.match(/(\d{4}年\d{1,2}月\d{1,2}日发布)/);

    // 大类
    const majorMatch = text.match(/([1-4]区)\s*(医学|理学|工学|农学|经济学|管理学|[^\s<]+)/);

    // 小类
    const subCategories: Array<{ zone: string; subject: string }> = [];
    const subMatches = text.matchAll(/([1-4]区)\s*(?:<\/[^>]+>\s*)?([^\s<]+(?:\s+[A-Z]+)?)/g);
    for (const sm of subMatches) {
      if (sm[2] && sm[2] !== majorMatch?.[2]) {
        subCategories.push({ zone: sm[1], subject: sm[2].trim() });
      }
    }

    const isTop = /TOP期刊[^否]*是/i.test(text) || /是\s*<\/td>/i.test(text);
    const isReview = /综述期刊[^否]*是/i.test(text);

    if (versionMatch) {
      result.push({
        version: versionMatch[1],
        publishDate: dateMatch?.[1],
        majorCategory: majorMatch ? `${majorMatch[1]} ${majorMatch[2]}` : "",
        subCategories,
        isTop,
        isReview,
      });
    }
  }

  return result;
}

/**
 * 解析 JCR 学科分区
 */
function parseJCRPartitions(html: string): LetPubJournalDetail["jcrPartitions"] {
  const result: LetPubJournalDetail["jcrPartitions"] = [];

  // JCR 表格通常格式：学科名称 | 收录数据库 | JCR分区 | 分区排名
  const jcrSection = html.match(/JCR学科分类[^]*?<\/table>/i);
  if (jcrSection) {
    const rows = jcrSection[0].matchAll(
      /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/gi
    );
    for (const row of rows) {
      const subject = row[1].trim();
      const database = row[2].trim();
      const zone = row[3].trim();
      const rank = row[4].trim();
      if (subject && zone.match(/Q[1-4]/i)) {
        result.push({ subject, database, zone, rank });
      }
    }
  }

  return result;
}

/**
 * 解析 JCI 学科分区
 */
function parseJCIPartitions(html: string): LetPubJournalDetail["jciPartitions"] {
  const result: LetPubJournalDetail["jciPartitions"] = [];

  const jciSection = html.match(/JCI学科分类[^]*?<\/table>/i);
  if (jciSection) {
    const rows = jciSection[0].matchAll(
      /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/gi
    );
    for (const row of rows) {
      const subject = row[1].trim();
      const database = row[2].trim();
      const zone = row[3].trim();
      const rank = row[4].trim();
      if (subject && zone.match(/Q[1-4]/i)) {
        result.push({ subject, database, zone, rank });
      }
    }
  }

  return result;
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
