/**
 * publication_costs extractor（B.2.1.A + B.2.1.B 扩展）
 *
 * 数据源优先级：
 *   1. DOAJ has_apc + max[].price/currency  →  source = "doaj"，openAccess = true
 *   2. journal.apcFee (DB 已有字段)         →  source = "journal_apc_field"
 *   3. (B.2.1.B) 期刊官网 LLM 抽出 APC      →  source = "journal_website_llm"
 *   4. 都没有 → null
 *
 * B.2.1.B 路径（extractPublicationCostsFromWebsite）走 chat() LLM 解析，单独 export
 * 给 orchestrator 在 doaj/apcFee 都失败时 fallback 调用。
 */

import * as cheerio from "cheerio";
import { logger } from "../../../config/logger.js";
import { chat } from "../../ai/chat-service.js";
import type { PublicationCostsShape, DoajJournalRecord } from "../types.js";

const MAX_INPUT_CHARS = 6000;

export interface CostsInput {
  doaj: DoajJournalRecord | null;
  journalApcFee?: number | null; // DB existing column
}

export function extractPublicationCosts(input: CostsInput): PublicationCostsShape | null {
  const { doaj, journalApcFee } = input;

  // 优先 DOAJ
  if (doaj && doaj.bibjson) {
    const apcInfo = doaj.bibjson.apc;
    if (apcInfo && apcInfo.has_apc && Array.isArray(apcInfo.max) && apcInfo.max.length > 0) {
      const top = apcInfo.max[0];
      if (typeof top.price === "number" && top.price >= 0) {
        return {
          apc: top.price,
          currency: top.currency || "USD",
          openAccess: true, // DOAJ 收录 = OA
          fastTrack: false, // DOAJ 不区分，默认 false
          source: "doaj",
          lastUpdatedAt: new Date().toISOString(),
        };
      }
    }
    // DOAJ 收录但 has_apc=false 或没价格：这是免费 OA 期刊（Diamond OA）
    if (apcInfo && apcInfo.has_apc === false) {
      return {
        apc: 0,
        currency: "USD",
        openAccess: true,
        fastTrack: false,
        source: "doaj",
        lastUpdatedAt: new Date().toISOString(),
      };
    }
  }

  // 兜底：DB 已有 apcFee 字段（多为非 OA 期刊的 page charge 估值）
  if (typeof journalApcFee === "number" && journalApcFee > 0) {
    return {
      apc: journalApcFee,
      currency: "USD",
      openAccess: undefined, // 不知道
      fastTrack: undefined,
      source: "journal_apc_field",
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  return null;
}

// ============ B.2.1.B：官网 LLM fallback ============

export interface WebsiteCostsInput {
  websiteHtml: string | null;
  journalName: string;
  tenantId: string;
}

/** 抽 APC 相关页段（"Article Processing Charge" / "Open Access" / "Page Charge"）；exported for tests */
export function extractApcSection(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, iframe").remove();
  const fullText = $("body").text().replace(/\s+/g, " ").trim();
  const re =
    /(article processing charge|article-processing charge|publication fee|publication charge|page charge|open[- ]access fee|APC)[\s\S]{0,1500}/gi;
  const matches = fullText.match(re);
  if (matches && matches.length > 0) {
    return matches.join("\n\n").slice(0, MAX_INPUT_CHARS);
  }
  return fullText.slice(0, MAX_INPUT_CHARS);
}

const WEBSITE_PROMPT = (journalName: string, content: string) => `从以下期刊官网内容中识别 APC（Article Processing Charge）/ 版面费 / Page Charge。

期刊名: ${journalName}

官网内容（截断 ${MAX_INPUT_CHARS} 字）:
${content}

仅输出 JSON（不要任何解释 / markdown）:
{
  "apc": 3000,
  "currency": "USD",
  "openAccess": true,
  "fastTrack": false
}

规则:
- apc 必须是数字（USD/EUR/GBP/CNY 都接受），找不到留 null
- currency 三字符货币代码，未知 default "USD"
- openAccess 是否完全 OA 期刊（包含 hybrid OA option 也算 true），unsure 留 null
- fastTrack 期刊是否提供加急投稿，unsure 留 false
- 找不到任何 APC 数据 → apc: null，整个 JSON 仍输出`;

export async function extractPublicationCostsFromWebsite(
  input: WebsiteCostsInput,
): Promise<PublicationCostsShape | null> {
  if (!input.websiteHtml) return null;
  const text = extractApcSection(input.websiteHtml);
  if (text.length < 100) return null;

  const prompt = WEBSITE_PROMPT(input.journalName, text);

  let raw: string;
  try {
    const resp = await chat({
      tenantId: input.tenantId,
      userId: "enricher",
      conversationId: `costs-${input.journalName}`,
      message: prompt,
      skillType: "formatting", // → Qwen-Plus
    });
    raw = resp.content;
  } catch (err) {
    logger.warn(
      { journal: input.journalName, err: err instanceof Error ? err.message : String(err) },
      "publication-costs LLM 调用失败",
    );
    return null;
  }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (parsed.apc === null || parsed.apc === undefined) return null;
  const apc = Number(parsed.apc);
  if (!Number.isFinite(apc) || apc < 0 || apc > 50000) return null;

  return {
    apc,
    currency:
      typeof parsed.currency === "string" && /^[A-Z]{3}$/.test(parsed.currency.toUpperCase())
        ? parsed.currency.toUpperCase()
        : "USD",
    openAccess: typeof parsed.openAccess === "boolean" ? parsed.openAccess : undefined,
    fastTrack: typeof parsed.fastTrack === "boolean" ? parsed.fastTrack : false,
    source: "journal_website_llm",
    lastUpdatedAt: new Date().toISOString(),
  };
}
