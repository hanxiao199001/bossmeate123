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
/**
 * 期刊数据卡 —— **自适应格子**（8-10 改造）。
 *
 * ## 改造前的问题
 *
 * 原实现是**固定四格** IF / 分区 / 录用率 / 审稿周期, 每格无数据时填 `"N/A"`。
 * 对 sparse 刊(实测占内容的 57.6%, 且国内刊池 rich 恒为 0)画出来就是**满卡 N/A** ——
 * 正是红线 #14 补充上限禁止的形态: 「一格暂无是诚实, 满卡暂无是空洞」。
 *
 * ## 现在的规则
 *
 *   ① **有什么画什么**: 逐格判定, 无数据的格子**整格不出现**(不是填 N/A)
 *   ② sparse 刊用目录/学科/主办方补位 —— 这三类**零编造风险**且它一定有
 *   ③ **不足 2 格就整张卡不画**(返回空串) —— 与 adapters/field-slot-guard.ts 的
 *      `shouldHideCard` 同一条逻辑: 撑不起一张卡的信息量, 画出来就是空洞
 *   ④ 宽度按实际格数自适应, 不留空位
 *
 * ⚠️ **渲染层的反编造纪律与正文一致**(红线 #14 管渲染侧的那半):
 *   绝不为了凑格子引入任何本刊没有的指标 —— 目录/学科/主办方是**它真有的属性**,
 *   不是指标的替代品。这里不做任何"无 IF 就写高影响力"式的降级。
 */
export function generateJournalDataCard(journal: {
  name: string;
  nameEn?: string | null;
  impactFactor?: number | null;
  partition?: string | null;
  casPartition?: string | null;
  acceptanceRate?: number | null;
  reviewCycle?: string | null;
  isWarningList?: boolean | null;
  catalogs?: unknown;
  cscdLevel?: string | null;
  pkuCoreLevel?: string | null;
  discipline?: string | null;
  publisher?: string | null;
}): string {
  interface Cell { value: string; label: string; color: string; size: number }
  const cells: Cell[] = [];

  // ---- 指标格(有才画, 绝不填 N/A) ----
  if (journal.impactFactor != null && journal.impactFactor > 0) {
    cells.push({ value: journal.impactFactor.toFixed(1), label: "影响因子 IF", color: "#059669", size: 28 });
  }
  const partition = journal.partition || journal.casPartition;
  if (partition) {
    const pc: Record<string, string> = { Q1: "#dc2626", Q2: "#ea580c", Q3: "#ca8a04", Q4: "#6b7280" };
    cells.push({ value: partition, label: "分区", color: pc[partition] || "#6b7280", size: partition.length > 4 ? 18 : 30 });
  }
  if (journal.acceptanceRate != null && journal.acceptanceRate > 0) {
    const pct = journal.acceptanceRate <= 1 ? journal.acceptanceRate * 100 : journal.acceptanceRate;
    cells.push({ value: `${pct.toFixed(0)}%`, label: "录用率", color: "#2563eb", size: 26 });
  }
  if (journal.reviewCycle) {
    cells.push({ value: String(journal.reviewCycle), label: "审稿周期", color: "#7c3aed", size: 16 });
  }

  // ---- sparse 补位格: 目录/学科/主办方(零编造风险, 且它一定有) ----
  if (cells.length < 4) {
    const cats: string[] = [];
    if (Array.isArray(journal.catalogs)) {
      const m: Record<string, string> = {
        "pku-core": "北大核心", cssci: "CSSCI", "cssci-ext": "CSSCI扩展", cscd: "CSCD", sci: "SCI", ssci: "SSCI",
      };
      for (const c of journal.catalogs) { const t = m[String(c)]; if (t) cats.push(t); }
    }
    if (cats.length === 0 && journal.pkuCoreLevel) cats.push(String(journal.pkuCoreLevel));
    if (cats.length === 0 && journal.cscdLevel) cats.push(`CSCD${journal.cscdLevel}`);
    if (cats.length > 0) {
      cells.push({ value: cats.slice(0, 2).join(" · "), label: "收录", color: "#0891b2", size: cats.join("").length > 6 ? 14 : 18 });
    }
    if (cells.length < 4 && journal.discipline) {
      const d = String(journal.discipline);
      cells.push({ value: d.length > 8 ? `${d.slice(0, 7)}…` : d, label: "学科", color: "#4f46e5", size: d.length > 5 ? 15 : 20 });
    }
    if (cells.length < 4 && journal.publisher) {
      const pb = String(journal.publisher);
      cells.push({ value: pb.length > 9 ? `${pb.slice(0, 8)}…` : pb, label: "主办", color: "#64748b", size: pb.length > 6 ? 13 : 17 });
    }
  }

  // ③ 撑不起一张卡就别画 —— 同 field-slot-guard.shouldHideCard 的逻辑
  if (cells.length < 2) return "";

  const shown = cells.slice(0, 4);
  const n = shown.length;
  const GAP = 20;
  const PAD = 30;
  const W = 600;
  const cw = Math.floor((W - PAD * 2 - GAP * (n - 1)) / n);
  const warning = journal.isWarningList ? "⚠️ 预警期刊" : "";

  const boxes = shown
    .map((c, i) => {
      const x = PAD + i * (cw + GAP);
      const cx = x + cw / 2;
      return `<rect x="${x}" y="90" width="${cw}" height="80" rx="10" fill="white" stroke="#e5e7eb"/>` +
        `<text x="${cx}" y="${c.size >= 24 ? 122 : 126}" font-family="system-ui,sans-serif" font-size="${c.size}" font-weight="bold" fill="${c.color}" text-anchor="middle">${escapeXml(c.value)}</text>` +
        `<text x="${cx}" y="148" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">${escapeXml(c.label)}</text>`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="200" viewBox="0 0 ${W} 200" style="max-width:100%;display:block;margin:0 auto;">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f0fdf4;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ecfeff;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="200" rx="16" fill="url(#bg)" stroke="#d1d5db" stroke-width="1"/>
  <text x="30" y="40" font-family="system-ui,sans-serif" font-size="18" font-weight="bold" fill="#111827">${escapeXml(journal.name)}</text>
  ${journal.nameEn ? `<text x="30" y="62" font-family="system-ui,sans-serif" font-size="12" fill="#6b7280">${escapeXml(journal.nameEn)}</text>` : ""}
  ${warning ? `<text x="570" y="40" font-family="system-ui,sans-serif" font-size="13" fill="#dc2626" text-anchor="end">${warning}</text>` : ""}
  <line x1="30" y1="75" x2="570" y2="75" stroke="#e5e7eb" stroke-width="1"/>
  ${boxes}
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
