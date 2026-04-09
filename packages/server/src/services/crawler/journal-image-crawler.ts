/**
 * 期刊图片抓取服务
 *
 * 功能：
 * 1. 从 LetPub 期刊详情页抓取封面图
 * 2. 生成期刊数据信息卡片（SVG）
 *
 * LetPub 期刊详情页 URL 格式：
 * https://www.letpub.com.cn/index.php?page=journalapp&view=detail&journalid=ISSN
 *
 * 页面中 <img> 通常包含封面图：
 * <img src="journalcover/xxx.jpg" ...>
 */

import { logger } from "../../config/logger.js";

const LETPUB_BASE = "https://www.letpub.com.cn";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 从 LetPub 抓取期刊封面图 URL
 */
export async function fetchJournalCoverFromLetPub(
  journalName: string,
  issn?: string
): Promise<string | null> {
  try {
    // 方式1: 通过 ISSN 搜索
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Referer: `${LETPUB_BASE}/index.php?page=journalapp`,
        Accept: "text/html",
      },
      body: formData.toString(),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();

    // 提取期刊详情页链接
    const detailLinkMatch = html.match(
      /href="(index\.php\?page=journalapp&view=detail&journalid=[^"]+)"/
    );

    if (!detailLinkMatch) {
      // 尝试直接从搜索结果页提取封面图
      return extractCoverFromHtml(html);
    }

    // 访问详情页
    const detailUrl = `${LETPUB_BASE}/${detailLinkMatch[1]}`;
    const detailController = new AbortController();
    const detailTimeout = setTimeout(() => detailController.abort(), 10000);

    const detailRes = await fetch(detailUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: searchUrl,
        Accept: "text/html",
      },
      signal: detailController.signal,
    });

    clearTimeout(detailTimeout);

    if (!detailRes.ok) return null;

    const detailHtml = await detailRes.text();
    return extractCoverFromHtml(detailHtml);
  } catch (err) {
    logger.warn({ journalName, error: String(err) }, "LetPub封面图抓取失败");
    return null;
  }
}

/**
 * 从 HTML 中提取期刊封面图 URL
 */
function extractCoverFromHtml(html: string): string | null {
  // LetPub 封面图通常在 <img src="journalcover/xxx.jpg">
  const coverPatterns = [
    /src="((?:https?:\/\/[^"]*)?journalcover\/[^"]+)"/i,
    /src="((?:https?:\/\/[^"]*)?journal_cover\/[^"]+)"/i,
    /src="((?:https?:\/\/[^"]*)?(?:\/[^"]*)?cover[^"]*\.(?:jpg|png|gif|webp))"/i,
    /src="(\/uploads\/[^"]*\.(?:jpg|png|gif|webp))"/i,
  ];

  for (const pattern of coverPatterns) {
    const match = html.match(pattern);
    if (match) {
      let url = match[1];
      // 补全相对路径
      if (!url.startsWith("http")) {
        url = `${LETPUB_BASE}/${url.replace(/^\//, "")}`;
      }
      return url;
    }
  }

  return null;
}

/**
 * 从 CrossRef API 获取期刊封面图（备用方案）
 * CrossRef 提供部分期刊的封面信息，ISSN 匹配效果更好
 */
export async function fetchJournalCoverFromCrossRef(
  journalName: string,
  issn?: string
): Promise<string | null> {
  try {
    // 用期刊名搜索 CrossRef
    const query = issn || encodeURIComponent(journalName);
    const url = issn
      ? `https://api.crossref.org/journals/${issn}`
      : `https://api.crossref.org/journals?query=${query}&rows=1`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(url, {
      headers: { "User-Agent": "BossMate/1.0 (mailto:support@bossmate.com)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;

    const data = await resp.json() as any;

    // 从 CrossRef 结果中提取 ISSN 信息用于封面图
    let resolvedIssn: string | null = null;
    if (issn) {
      resolvedIssn = issn;
    } else if (data.message?.items?.[0]?.ISSN?.[0]) {
      resolvedIssn = data.message.items[0].ISSN[0];
    }

    // 用 ISSN 构造常见的期刊封面图 URL 模式
    if (resolvedIssn) {
      const cleanIssn = resolvedIssn.replace("-", "").toLowerCase();
      // Springer/Nature 封面图模式 — 优先高清大图（w316），回退中等（w153）
      const sizes = ["w316", "w153", "w92"];
      for (const size of sizes) {
        const springerUrl = `https://media.springernature.com/${size}/springer-static/cover-hires/journal/${cleanIssn}`;
        try {
          const imgResp = await fetch(springerUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          if (imgResp.ok && imgResp.headers.get("content-type")?.startsWith("image")) {
            return springerUrl;
          }
        } catch { /* 尝试下一个尺寸 */ }
      }
    }

    return null;
  } catch (err) {
    logger.debug({ journalName, error: String(err) }, "CrossRef封面图查询失败");
    return null;
  }
}

/**
 * 多源抓取期刊封面图（LetPub → CrossRef → 数据卡片保底）
 */
export async function fetchJournalCoverMultiSource(
  journalName: string,
  issn?: string
): Promise<string | null> {
  // 源1: LetPub
  let cover = await fetchJournalCoverFromLetPub(journalName, issn);
  if (cover) {
    logger.info({ journalName, source: "letpub" }, "期刊封面图抓取成功");
    return cover;
  }

  // 源2: CrossRef / Springer
  cover = await fetchJournalCoverFromCrossRef(journalName, issn);
  if (cover) {
    logger.info({ journalName, source: "crossref" }, "期刊封面图抓取成功");
    return cover;
  }

  logger.warn({ journalName }, "所有源均未找到封面图，将使用数据卡片");
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
      coverUrl = await fetchJournalCoverFromLetPub(j.name, j.issn);
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
