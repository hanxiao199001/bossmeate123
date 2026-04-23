/**
 * 期刊图片抓取服务
 *
 * 功能：
 * 1. 从 LetPub 抓取期刊封面图（阿里云 OSS CDN）
 * 2. 生成期刊数据信息卡片（SVG 备用图）
 *
 * LetPub 封面图获取流程：
 * 1. GET 搜索 → 提取 journalid
 * 2. 拼接 CDN URL: https://media-cdn.oss-cn-hangzhou.aliyuncs.com/statics/images/comment_center/cover/journal/{journalid}.jpg
 * 3. HEAD 验证图片可用且非占位图
 *
 * 注意：Springer CDN (media.springernature.com) 从中国大陆 IP 访问全部返回占位图，不可用
 */

import { logger } from "../../config/logger.js";

const LETPUB_BASE = "https://www.letpub.com.cn";
const LETPUB_CDN = "https://media-cdn.oss-cn-hangzhou.aliyuncs.com/statics/images/comment_center/cover/journal";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 从 LetPub 搜索结果中提取 journalid，然后拼接阿里云 CDN 封面图 URL
 */
export async function fetchJournalCoverFromLetPub(
  journalName: string,
  issn?: string
): Promise<string | null> {
  try {
    // 预处理期刊名：LetPub 搜索不支持 & 符号，需替换为 and
    const cleanName = journalName
      .replace(/\s*&\s*/g, " and ")   // & → and
      .replace(/[^\w\s\-().,:]/g, "") // 去除其他特殊字符
      .trim();

    // 使用 GET 搜索（POST 搜索结果不包含详情链接）
    const params = new URLSearchParams({
      page: "journalapp",
      view: "search",
      searchname: cleanName,
      searchissn: issn || "",
      searchsort: "relevance",
      currentsearchpage: "1",
    });
    const searchUrl = `${LETPUB_BASE}/index.php?${params.toString()}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return null;

    const html = await response.text();

    // 从搜索结果中提取 journalid（详情页链接格式：journalid=数字）
    const journalIdMatch = html.match(/journalid=(\d+).*?view=detail/);
    if (!journalIdMatch) {
      // 尝试反向匹配（view=detail在前）
      const altMatch = html.match(/view=detail.*?journalid=(\d+)/);
      if (!altMatch) {
        logger.debug({ journalName, issn }, "LetPub 搜索结果中未找到 journalid");
        return null;
      }
      return await verifyLetPubCover(altMatch[1], journalName);
    }

    return await verifyLetPubCover(journalIdMatch[1], journalName);
  } catch (err) {
    logger.warn({ journalName, error: String(err) }, "LetPub 封面图抓取失败");
    return null;
  }
}

/**
 * 验证 LetPub CDN 封面图是否真实存在（非 404、非空图）
 */
async function verifyLetPubCover(journalId: string, journalName: string): Promise<string | null> {
  const coverUrl = `${LETPUB_CDN}/${journalId}.jpg`;

  try {
    // 先用 HEAD 快速检查
    const headResp = await fetch(coverUrl, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });

    if (!headResp.ok) {
      logger.debug({ coverUrl, status: headResp.status }, "LetPub CDN 封面图不存在");
      return null;
    }

    const contentType = headResp.headers.get("content-type") || "";
    if (!contentType.startsWith("image")) {
      logger.debug({ coverUrl, contentType }, "LetPub CDN 返回非图片内容");
      return null;
    }

    // 检查文件大小，过滤占位图（真实封面通常 > 5KB）
    const contentLength = parseInt(headResp.headers.get("content-length") || "0", 10);
    if (contentLength > 0 && contentLength < 3000) {
      logger.debug({ coverUrl, contentLength }, "LetPub CDN 封面图太小，可能是占位图");
      return null;
    }

    logger.info({ coverUrl, journalName, journalId, contentLength }, "LetPub 封面图验证通过");
    return coverUrl;
  } catch (err) {
    logger.debug({ coverUrl, error: String(err) }, "LetPub CDN 封面图验证失败");
    return null;
  }
}

/**
 * 直接从 LetPub 详情页 HTML 提取封面图（备用方案）
 * 当 CDN URL 不可用时，从详情页 HTML 中提取 media-cdn 图片链接
 */
async function fetchCoverFromDetailPage(journalId: string, journalName: string): Promise<string | null> {
  try {
    const detailUrl = `${LETPUB_BASE}/index.php?journalid=${journalId}&page=journalapp&view=detail`;
    const resp = await fetch(detailUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return null;

    const html = await resp.text();

    // 匹配阿里云 CDN 上的封面图 URL
    const cdnCoverMatch = html.match(
      /src="(https:\/\/media-cdn[^"]*\/cover\/journal\/\d+\.jpg[^"]*)"/i
    );
    if (cdnCoverMatch) {
      // 去掉版本号参数
      const url = cdnCoverMatch[1].split("?")[0];
      logger.info({ url, journalName }, "从详情页 HTML 提取到封面图");
      return url;
    }

    return null;
  } catch (err) {
    logger.debug({ journalId, error: String(err) }, "详情页封面图提取失败");
    return null;
  }
}

/**
 * 多源抓取期刊封面图
 * 策略：LetPub CDN (journalid) → LetPub 详情页 HTML → 放弃（使用数据卡片）
 */
export async function fetchJournalCoverMultiSource(
  journalName: string,
  issn?: string
): Promise<string | null> {
  // 源1: LetPub GET 搜索 → CDN 封面图
  const cover = await fetchJournalCoverFromLetPub(journalName, issn);
  if (cover) {
    logger.info({ journalName, source: "letpub-cdn" }, "期刊封面图抓取成功");
    return cover;
  }

  logger.warn({ journalName }, "未找到封面图，将使用数据卡片");
  return null;
}

/**
 * 生成期刊数据信息卡片 SVG
 * 包含：期刊名、IF、分区、录用率、审稿周期
 */
export function generateJournalDataCard(journal: {
  name: string;
  nameEn?: string | null;
  impactFactor?: number | null;
  partition?: string | null;
  acceptanceRate?: number | null;
  reviewCycle?: string | null;
  isWarningList?: boolean | null;
}): string {
  const ifText = journal.impactFactor ? journal.impactFactor.toFixed(1) : "N/A";
  const partition = journal.partition || "N/A";
  const acceptRate = journal.acceptanceRate
    ? `${(journal.acceptanceRate * 100).toFixed(0)}%`
    : "N/A";
  const cycle = journal.reviewCycle || "N/A";
  const warning = journal.isWarningList ? "⚠️ 预警期刊" : "";

  // 分区颜色
  const partitionColor: Record<string, string> = {
    Q1: "#dc2626",
    Q2: "#ea580c",
    Q3: "#ca8a04",
    Q4: "#6b7280",
  };
  const pColor = partitionColor[partition] || "#6b7280";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f0fdf4;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ecfeff;stop-opacity:1" />
    </linearGradient>
    <filter id="shadow" x="-2%" y="-2%" width="104%" height="104%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#00000015"/>
    </filter>
  </defs>
  <rect width="600" height="200" rx="16" fill="url(#bg)" stroke="#d1d5db" stroke-width="1" filter="url(#shadow)"/>
  <!-- 标题 -->
  <text x="30" y="40" font-family="system-ui,sans-serif" font-size="18" font-weight="bold" fill="#111827">${escapeXml(journal.name)}</text>
  ${journal.nameEn ? `<text x="30" y="62" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280">${escapeXml(journal.nameEn)}</text>` : ""}
  ${warning ? `<text x="540" y="40" font-family="system-ui,sans-serif" font-size="13" fill="#dc2626" text-anchor="end">${warning}</text>` : ""}
  <!-- 数据行 -->
  <line x1="30" y1="75" x2="570" y2="75" stroke="#e5e7eb" stroke-width="1"/>
  <!-- IF -->
  <rect x="30" y="90" width="120" height="80" rx="10" fill="white" stroke="#e5e7eb"/>
  <text x="90" y="120" font-family="system-ui,sans-serif" font-size="28" font-weight="bold" fill="#059669" text-anchor="middle">${ifText}</text>
  <text x="90" y="145" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">影响因子 IF</text>
  <!-- 分区 -->
  <rect x="170" y="90" width="120" height="80" rx="10" fill="white" stroke="#e5e7eb"/>
  <text x="230" y="125" font-family="system-ui,sans-serif" font-size="32" font-weight="bold" fill="${pColor}" text-anchor="middle">${partition}</text>
  <text x="230" y="145" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">JCR分区</text>
  <!-- 录用率 -->
  <rect x="310" y="90" width="120" height="80" rx="10" fill="white" stroke="#e5e7eb"/>
  <text x="370" y="120" font-family="system-ui,sans-serif" font-size="26" font-weight="bold" fill="#2563eb" text-anchor="middle">${acceptRate}</text>
  <text x="370" y="145" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">录用率</text>
  <!-- 审稿周期 -->
  <rect x="450" y="90" width="120" height="80" rx="10" fill="white" stroke="#e5e7eb"/>
  <text x="510" y="120" font-family="system-ui,sans-serif" font-size="18" font-weight="bold" fill="#7c3aed" text-anchor="middle">${escapeXml(cycle)}</text>
  <text x="510" y="145" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">审稿周期</text>
</svg>`;
}

/**
 * 将 SVG 转为 data URI（可直接嵌入 img src）
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

/**
 * 批量获取期刊图片（封面 + 数据卡片）
 */
export async function fetchJournalImages(
  journals: Array<{
    name: string;
    nameEn?: string;
    issn?: string;
    impactFactor?: number;
    partition?: string;
    acceptanceRate?: number;
    reviewCycle?: string;
    isWarningList?: boolean;
  }>
): Promise<
  Map<
    string,
    { coverUrl: string | null; dataCardSvg: string; dataCardUri: string }
  >
> {
  const result = new Map<
    string,
    { coverUrl: string | null; dataCardSvg: string; dataCardUri: string }
  >();

  for (const j of journals) {
    // 1. 抓取封面图（限速，每个期刊间隔 500ms）
    let coverUrl: string | null = null;
    try {
      coverUrl = await fetchJournalCoverMultiSource(j.name, j.issn);
    } catch {
      // 封面抓取失败不阻塞
    }

    // 2. 生成数据信息卡片
    const dataCardSvg = generateJournalDataCard(j);
    const dataCardUri = svgToDataUri(dataCardSvg);

    result.set(j.name, { coverUrl, dataCardSvg, dataCardUri });

    // 限速
    if (journals.indexOf(j) < journals.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return result;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
