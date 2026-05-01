/**
 * 万方期刊详情页 extractor（B.4-2）。
 *
 * cheerio 选 #basicInfo li / .ico-book[title] / .principal-factors。
 * PIPL 邮箱过滤：白名单前缀 (editor/office/journal/nmjc/zhyx) + 黑名单兜底
 * 任何不命中白名单的邮箱直接丢弃（保留 NULL，不显示）。
 */
import * as cheerio from "cheerio";
import { logger } from "../../../config/logger.js";
import type { WanfangFetchResult } from "../fetchers/wanfang-fetcher.js";

export interface WanfangExtractedShape {
  /** 编辑部投稿地址（如 "北京市西城区宣武门东河沿街69号"） */
  submissionAddress?: string;
  /** 邮政编码（如 "200030"） */
  postCode?: string;
  /** 编辑部电话（如 "010-51322161"） */
  editorPhone?: string;
  /** 传真 */
  editorFax?: string;
  /**
   * 编辑部职务邮箱（PIPL 过滤后保留）。白名单不命中则 undefined。
   * 不收录作者 / 审稿人个人邮箱（PIPL 个人信息保护）。
   */
  editorEmail?: string;
  /** 主编（中文姓名） */
  editorInChief?: string;
  /** 主管单位 */
  authorityUnit?: string;
  /** 主办单位 */
  organizingUnit?: string;
  /** 国内统一刊号 CN（如 "11-2137/R"） */
  cnNumber?: string;
  /** 国际刊号 ISSN（用于反向校验） */
  issn?: string;
  /** 邮发代号 */
  postalCode?: string;
  /** 中信所核心影响因子（中文 IF，OpenAlex 无） */
  cnImpactFactor?: number;
  /**
   * SSR 动态校验：CSCD 收录 + 收录年份。
   * orchestrator 仅当 journals.cscd_level NULL 时回写，不覆盖 B.4-1 静态权威。
   */
  cscdLevelDynamic?: string;
  cscdYear?: string;
  /** SSR 动态校验：北大核心 + 收录年份（同上语义） */
  pkuCoreDynamic?: string;
  pkuCoreYear?: string;
  /** 数据采集时间戳 */
  fetchedAt: string;
  /** 来源 URL（debug） */
  sourceUrl: string;
}

/** PIPL 邮箱白名单：仅职务 / 编辑部 prefix 通过。 */
const EMAIL_WHITELIST_PREFIX = /^(editor|editors|office|journal|admin|info|contact|nmjc|zhyx|bjb|zazhi)/i;
const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** PIPL 过滤：仅放行白名单 prefix 的职务邮箱；未命中 return undefined。 */
export function filterEditorEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(EMAIL_REGEX);
  if (!m) return undefined;
  const email = m[0].toLowerCase();
  const localPart = email.split("@")[0];
  if (!EMAIL_WHITELIST_PREFIX.test(localPart)) {
    logger.debug({ email }, "wanfang PIPL: 非白名单邮箱前缀，丢弃");
    return undefined;
  }
  return email;
}

/** 从 #basicInfo 的 li 列表里按 strong 标签的 label 文本拿 value（去全角空格 / 冒号）。 */
function pickFromBasicInfo($: cheerio.CheerioAPI, label: string): string | undefined {
  let val: string | undefined;
  $("#basicInfo li").each((_, li) => {
    const text = $(li).text().replace(/\s/g, ""); // 去所有空白（含全角）
    const norm = label.replace(/\s/g, "");
    // pattern: 主管单位:中国科学技术协会 → 找 "主管单位" 后的部分
    const idx = text.indexOf(norm);
    if (idx === 0) {
      const after = text.slice(norm.length).replace(/^[：:]/, "");
      if (after) {
        val = after;
        return false; // break
      }
    }
  });
  return val;
}

/**
 * 从 .ico-book[title] 拿 CSCD / 北大核心 收录信号 + 年份。
 * title 格式：'中文核心期刊要目总览(北大核心期刊) (PKU)，收录年份：2023'
 */
function pickIcoBook($: cheerio.CheerioAPI, code: "PKU" | "CSCD"): { level: string; year?: string } | undefined {
  let result: { level: string; year?: string } | undefined;
  $(".ico-book").each((_, el) => {
    const txt = $(el).text().trim();
    if (txt !== code) return;
    const title = $(el).attr("title") ?? "";
    const yearMatch = title.match(/收录年份：(\d{4})/);
    result = {
      level: code === "PKU" ? "北大核心" : "核心库",
      year: yearMatch?.[1],
    };
    return false; // break
  });
  return result;
}

/** 从 .principal-factors 拿中文 IF，"中信所核心影响因子：2.123" → 2.123 */
function pickCnImpactFactor($: cheerio.CheerioAPI): number | undefined {
  const text = $(".principal-factors").first().text().replace(/\s/g, "");
  const m = text.match(/中信所核心影响因子[：:]([\d.]+)/);
  if (!m) return undefined;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) && val >= 0 && val <= 200 ? val : undefined;
}

/** 主入口：从 raw HTML 抽 wanfang 字段。 */
export function extractWanfangPeriodical(
  raw: WanfangFetchResult | null,
): WanfangExtractedShape | null {
  if (!raw) return null;
  const $ = cheerio.load(raw.html);

  const out: WanfangExtractedShape = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: raw.url,
  };

  // basicInfo 字段
  out.authorityUnit = pickFromBasicInfo($, "主管单位");
  out.organizingUnit = pickFromBasicInfo($, "主办单位");
  out.editorInChief = pickFromBasicInfo($, "主编");
  out.cnNumber = pickFromBasicInfo($, "国内刊号");
  out.issn = pickFromBasicInfo($, "国际刊号");
  out.postalCode = pickFromBasicInfo($, "邮发代号");
  out.editorPhone = pickFromBasicInfo($, "电话");
  out.editorFax = pickFromBasicInfo($, "传真");
  out.submissionAddress = pickFromBasicInfo($, "地址");
  out.postCode = pickFromBasicInfo($, "邮政编码");

  // PIPL 邮箱过滤
  out.editorEmail = filterEditorEmail(pickFromBasicInfo($, "电子邮箱"));

  // 中文 IF（中信所）
  out.cnImpactFactor = pickCnImpactFactor($);

  // CSCD / 北大核心 SSR 动态校验
  const pku = pickIcoBook($, "PKU");
  if (pku) {
    out.pkuCoreDynamic = pku.level;
    out.pkuCoreYear = pku.year;
  }
  const cscd = pickIcoBook($, "CSCD");
  if (cscd) {
    out.cscdLevelDynamic = cscd.level;
    out.cscdYear = cscd.year;
  }

  // sanity：所有字段都空 → return null（节省 jsonb 空行）
  const hasAny = Boolean(
    out.submissionAddress || out.editorPhone || out.editorEmail ||
    out.cnImpactFactor || out.pkuCoreDynamic || out.cscdLevelDynamic ||
    out.editorInChief || out.cnNumber,
  );
  return hasAny ? out : null;
}
