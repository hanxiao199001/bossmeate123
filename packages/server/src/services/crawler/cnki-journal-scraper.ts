/**
 * 知网（CNKI）期刊导航爬虫
 *
 * 数据源：https://navi.cnki.net/knavi/journals/searchbaseinfo
 *
 * 抓取内容：
 * - 期刊基本信息：刊名、CN 刊号、ISSN、主办单位、主管单位、刊期
 * - 影响因子：复合影响因子、综合影响因子
 * - 核心收录：北大核心、CSSCI、CSCD、CSTPCD 等
 * - 期刊主页 URL
 *
 * 注意：知网有反爬机制，需要控制频率
 */

import { logger } from "../../config/logger.js";

// ============ 类型定义 ============

export interface CnkiJournalDetail {
  /** 期刊中文名 */
  name: string;
  /** 英文名（如有） */
  nameEn: string | null;
  /** ISSN */
  issn: string | null;
  /** CN 刊号 */
  cnNumber: string | null;
  /** 主办单位 */
  organizer: string | null;
  /** 主管单位 */
  supervisor: string | null;
  /** 刊期（月刊/双月刊/季刊） */
  frequency: string | null;
  /** 创刊年份 */
  foundingYear: number | null;
  /** 复合影响因子（知网特有） */
  compositeIF: number | null;
  /** 综合影响因子（知网特有） */
  comprehensiveIF: number | null;
  /** 核心收录目录列表 */
  catalogs: string[];
  /** 核心版学科分类 */
  coreSubjects: string[];
  /** 期刊在知网的 URL */
  cnkiUrl: string | null;
  /** 语种 */
  language: string | null;
}

// ============ 主入口 ============

/**
 * 搜索知网期刊导航，获取期刊详细信息
 *
 * @param journalName - 期刊名称（中文）
 * @param issn - ISSN（可选，用于精确匹配）
 */
export async function scrapeCnkiJournal(
  journalName: string,
  issn?: string
): Promise<CnkiJournalDetail | null> {
  try {
    // 第一步：搜索期刊
    const searchResult = await searchCnkiJournal(journalName);
    if (!searchResult) {
      logger.debug({ journalName }, "知网期刊搜索无结果");
      return null;
    }

    // 如果有 ISSN，优先匹配
    let matchedUrl = searchResult.url;
    if (issn && searchResult.results.length > 1) {
      const exactMatch = searchResult.results.find(r => r.issn === issn);
      if (exactMatch) matchedUrl = exactMatch.url;
    }

    // 第二步：抓取详情页
    const detail = await fetchCnkiDetail(matchedUrl, journalName);
    return detail;
  } catch (err) {
    logger.warn({ err: String(err), journalName }, "知网期刊爬取失败");
    return null;
  }
}

// ============ 搜索 ============

interface SearchResult {
  url: string;
  results: Array<{ name: string; issn: string; url: string }>;
}

async function searchCnkiJournal(journalName: string): Promise<SearchResult | null> {
  // 知网期刊导航搜索接口
  const searchUrl = "https://navi.cnki.net/knavi/journals/searchbaseinfo";
  const params = new URLSearchParams({
    searchValue: journalName,
    searchType: "刊名",
    clickType: "0",
  });

  const response = await fetchWithRetry(`${searchUrl}?${params.toString()}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://navi.cnki.net/knavi/journals",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    logger.debug({ status: response.status, journalName }, "知网搜索请求失败");
    return null;
  }

  const html = await response.text();

  // 解析搜索结果列表
  const results: Array<{ name: string; issn: string; url: string }> = [];
  // 匹配结果条目：<a href="/knavi/journals/XXXX/detail" ...>期刊名</a>
  const itemPattern = /<a[^>]*href="(\/knavi\/journals\/[^"]+\/detail)"[^>]*>([^<]+)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(html)) !== null) {
    const url = `https://navi.cnki.net${match[1]}`;
    const name = match[2].trim();
    // 尝试提取 ISSN
    const issnMatch = html.substring(match.index, match.index + 500).match(/ISSN[：:]\s*([\d-]{9})/i);
    results.push({
      name,
      issn: issnMatch ? issnMatch[1] : "",
      url,
    });
  }

  // 如果搜索结果页面直接是详情页（只有一个精确匹配）
  if (results.length === 0) {
    // 检查是否已经在详情页
    const detailCheck = html.match(/<title>([^<]*?)-中国知网/);
    if (detailCheck) {
      const directUrl = `https://navi.cnki.net/knavi/journals/searchbaseinfo?searchValue=${encodeURIComponent(journalName)}`;
      results.push({ name: detailCheck[1].trim(), issn: "", url: directUrl });
    }
  }

  if (results.length === 0) return null;

  // 优先精确匹配
  const exactMatch = results.find(r => r.name === journalName);
  return {
    url: exactMatch ? exactMatch.url : results[0].url,
    results,
  };
}

// ============ 详情页解析 ============

async function fetchCnkiDetail(
  detailUrl: string,
  fallbackName: string
): Promise<CnkiJournalDetail | null> {
  const response = await fetchWithRetry(detailUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://navi.cnki.net/knavi/journals",
    },
  });

  if (!response.ok) return null;
  const html = await response.text();

  return parseCnkiDetailHtml(html, detailUrl, fallbackName);
}

/**
 * 解析知网期刊详情页 HTML
 */
export function parseCnkiDetailHtml(
  html: string,
  cnkiUrl: string,
  fallbackName: string
): CnkiJournalDetail {
  const detail: CnkiJournalDetail = {
    name: fallbackName,
    nameEn: null,
    issn: null,
    cnNumber: null,
    organizer: null,
    supervisor: null,
    frequency: null,
    foundingYear: null,
    compositeIF: null,
    comprehensiveIF: null,
    catalogs: [],
    coreSubjects: [],
    cnkiUrl,
    language: null,
  };

  // ---- 基本信息提取 ----

  // 刊名
  const nameMatch = html.match(/(?:刊名|期刊名称)[：:]\s*(?:<[^>]*>)*\s*([^<\n]+)/i);
  if (nameMatch) detail.name = nameMatch[1].trim();

  // 英文名
  const nameEnMatch = html.match(/(?:英文刊名|Journal|并列题名)[：:]\s*(?:<[^>]*>)*\s*([^<\n]+)/i);
  if (nameEnMatch) detail.nameEn = nameEnMatch[1].trim();

  // ISSN
  const issnMatch = html.match(/ISSN[：:]\s*(?:<[^>]*>)*\s*([\d]{4}-[\d]{3}[\dXx])/i);
  if (issnMatch) detail.issn = issnMatch[1];

  // CN 刊号
  const cnMatch = html.match(/CN[：:]\s*(?:<[^>]*>)*\s*([A-Z0-9]{2}-[\d]{4}\/[A-Z]{1,2})/i);
  if (cnMatch) detail.cnNumber = cnMatch[1];

  // 主办单位
  const orgMatch = html.match(/主办单位[：:]\s*(?:<[^>]*>)*\s*([^<\n]+)/i);
  if (orgMatch) detail.organizer = orgMatch[1].trim();

  // 主管单位
  const supMatch = html.match(/主管单位[：:]\s*(?:<[^>]*>)*\s*([^<\n]+)/i);
  if (supMatch) detail.supervisor = supMatch[1].trim();

  // 刊期
  const freqMatch = html.match(/(?:出版周期|刊期)[：:]\s*(?:<[^>]*>)*\s*([\u4e00-\u9fa5]+刊)/i);
  if (freqMatch) detail.frequency = freqMatch[1];

  // 创刊年份
  const yearMatch = html.match(/创刊(?:年份|时间)?[：:]\s*(?:<[^>]*>)*\s*(\d{4})/i);
  if (yearMatch) detail.foundingYear = parseInt(yearMatch[1]);

  // 语种
  const langMatch = html.match(/(?:语种|出版语言)[：:]\s*(?:<[^>]*>)*\s*([\u4e00-\u9fa5]+)/i);
  if (langMatch) detail.language = langMatch[1];

  // ---- 影响因子 ----

  // 复合影响因子
  const compositeMatch = html.match(/复合影响因子[：:]\s*(?:<[^>]*>)*\s*([\d.]+)/i);
  if (compositeMatch) detail.compositeIF = parseFloat(compositeMatch[1]);

  // 综合影响因子
  const comprehensiveMatch = html.match(/综合影响因子[：:]\s*(?:<[^>]*>)*\s*([\d.]+)/i);
  if (comprehensiveMatch) detail.comprehensiveIF = parseFloat(comprehensiveMatch[1]);

  // ---- 核心收录 ----
  const catalogsSet = new Set<string>();

  // 北大核心 / 中文核心
  if (/北大核心|中文核心期刊要目总览|PKU/.test(html)) {
    catalogsSet.add("pku-core");
  }

  // CSSCI（南大核心）
  if (/CSSCI|中文社会科学引文索引/.test(html)) {
    catalogsSet.add("cssci");
  }

  // CSCD（中国科学引文数据库）
  if (/CSCD|中国科学引文数据库/.test(html)) {
    catalogsSet.add("cscd");
  }

  // CSTPCD（中国科技论文统计源）
  if (/CSTPCD|科技论文统计源|统计源期刊/.test(html)) {
    catalogsSet.add("cstpcd");
  }

  // AMI 综合评价
  if (/AMI.*综合评价|A刊/.test(html)) {
    catalogsSet.add("ami");
  }

  // JST（日本科学技术振兴机构）
  if (/JST|日本科学技术/.test(html)) {
    catalogsSet.add("jst");
  }

  // SCI/SCIE — 全局排除 CSSCI 干扰
  // "SCIE" 是独立词，不会出现在 CSSCI 中；"SCI" 可能是 CSSCI 的子串
  const hasCSSCI = /CSSCI/.test(html);
  if (/\bSCIE\b/.test(html)) {
    catalogsSet.add("scie");
  } else if (/\bSCI\b/.test(html) && !hasCSSCI) {
    catalogsSet.add("scie");
  }

  // EI
  if (/\bEI\b.*[Cc]ompendex|EI[核来]/.test(html)) {
    catalogsSet.add("ei");
  }

  detail.catalogs = Array.from(catalogsSet);

  // ---- 学科分类 ----
  // 匹配 "学科分类：计算机科学; 自动化技术" 或类似模式
  const subjectMatch = html.match(/(?:学科分类|所属学科)[：:]\s*(?:<[^>]*>)*\s*([^<\n]{2,80})/i);
  if (subjectMatch) {
    detail.coreSubjects = subjectMatch[1].split(/[;；,，、]/).map(s => s.trim()).filter(Boolean);
  }

  return detail;
}

// ============ 万方期刊爬虫 ============

export interface WanfangJournalDetail {
  name: string;
  nameEn: string | null;
  issn: string | null;
  cnNumber: string | null;
  organizer: string | null;
  compositeIF: number | null;
  catalogs: string[];
  wanfangUrl: string | null;
}

/**
 * 搜索万方期刊数据库，作为知网的补充数据源
 */
export async function scrapeWanfangJournal(
  journalName: string,
  issn?: string
): Promise<WanfangJournalDetail | null> {
  try {
    // 万方期刊搜索
    const searchUrl = `https://s.wanfangdata.com.cn/perio?q=${encodeURIComponent(journalName)}&style=detail`;

    const response = await fetchWithRetry(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.wanfangdata.com.cn/",
      },
    });

    if (!response.ok) return null;
    const html = await response.text();

    return parseWanfangHtml(html, journalName);
  } catch (err) {
    logger.debug({ err: String(err), journalName }, "万方期刊爬取失败");
    return null;
  }
}

function parseWanfangHtml(html: string, fallbackName: string): WanfangJournalDetail | null {
  const detail: WanfangJournalDetail = {
    name: fallbackName,
    nameEn: null,
    issn: null,
    cnNumber: null,
    organizer: null,
    compositeIF: null,
    catalogs: [],
    wanfangUrl: null,
  };

  // 期刊详情链接
  const urlMatch = html.match(/href="(\/perio\/[^"]+)"/);
  if (urlMatch) detail.wanfangUrl = `https://d.wanfangdata.com.cn${urlMatch[1]}`;

  // ISSN
  const issnMatch = html.match(/ISSN[：:]\s*([\d]{4}-[\d]{3}[\dXx])/i);
  if (issnMatch) detail.issn = issnMatch[1];

  // CN 刊号
  const cnMatch = html.match(/CN[：:]\s*([A-Z0-9]{2}-[\d]{4}\/[A-Z]{1,2})/i);
  if (cnMatch) detail.cnNumber = cnMatch[1];

  // 主办单位
  const orgMatch = html.match(/主办单位[：:]\s*([^<\n]+)/i);
  if (orgMatch) detail.organizer = orgMatch[1].trim();

  // 影响因子
  const ifMatch = html.match(/影响因子[：:]\s*([\d.]+)/i);
  if (ifMatch) detail.compositeIF = parseFloat(ifMatch[1]);

  // 核心收录
  if (/北大核心/.test(html)) detail.catalogs.push("pku-core");
  if (/CSSCI/.test(html)) detail.catalogs.push("cssci");
  if (/CSCD/.test(html)) detail.catalogs.push("cscd");

  // 放宽返回条件：有任一有价值信息即返回（标识号、IF、核心目录）
  const hasUsefulData = detail.issn || detail.cnNumber || detail.compositeIF ||
    detail.catalogs.length > 0 || detail.organizer;
  if (!hasUsefulData) return null;
  return detail;
}

// ============ 工具函数 ============

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 2
): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
      return response;
    } catch (err) {
      if (i === retries) throw err;
      // 等待 1-2 秒再重试
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }
  }
  throw new Error("fetchWithRetry exhausted");
}
