/**
 * scope-details extractor (B.2.1.B)
 *
 * 从期刊官网 HTML 用 DeepSeek LLM 抽取：
 *   - categories: 收稿范围分类（每类 title + description）
 *   - articleTypes: 接收的稿件类型（Original / Review / Commentary / ...）
 *   - submissionNote: 投稿提示（特殊要求 / 限制 / 推荐）
 *   - subjectDistribution: 学科分布百分比（如 Cardiology 23%）
 *
 * 实现要点：
 *  1. HTML 太大 → 切窗口 (cheerio 抽 main/article 文本，最多 6000 字)
 *  2. 走 chat() service，skillType="formatting" → Qwen-Plus 廉价路由
 *  3. 严格 JSON 解析；失败 return null（不抛错，orchestrator 走 partial OK）
 *  4. 字段清洗：percent 范围 / 字符串长度限制
 *
 * 不在范围：embedding 入库 / 多文件并发 / 自动 retry（chat-service 已有）
 */

import * as cheerio from "cheerio";
import { logger } from "../../../config/logger.js";
import { chat } from "../../ai/chat-service.js";
import type { ScopeDetailsShape, ScopeCategory } from "../types.js";

const MAX_INPUT_CHARS = 6000;

export interface ScopeDetailsInput {
  /** Journal 官网 fully-rendered HTML（stealth 抓回） */
  websiteHtml: string | null;
  /** 期刊名（给 LLM 上下文） */
  journalName: string;
  /** tenantId for chat-service token tracking */
  tenantId: string;
}

/**
 * 从原始 HTML 抽取主体文本（去 nav/footer/script），限定字数
 * Exported for unit tests.
 */
export function extractMainText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, iframe").remove();
  // 优先 main/article，其次 body
  const candidates = ["main", "article", '[role="main"]', "#main", ".main-content", "body"];
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length > 0) {
      const text = el.text().replace(/\s+/g, " ").trim();
      if (text.length >= 200) {
        return text.slice(0, MAX_INPUT_CHARS);
      }
    }
  }
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
}

const PROMPT_TEMPLATE = (journalName: string, content: string) => `从以下期刊官网内容中抽取期刊收稿范围相关结构化信息。

期刊名: ${journalName}

官网内容（截断 ${MAX_INPUT_CHARS} 字）:
${content}

仅输出 JSON（不要任何解释 / markdown）:
{
  "categories": [
    {"title": "分类名（如 Clinical Research）", "description": "1-2 句描述"}
  ],
  "articleTypes": ["Original Research", "Review", "Commentary"],
  "submissionNote": "投稿提示（如有特殊要求，否则空字符串）",
  "subjectDistribution": [
    {"subject": "Cardiology", "percent": 23}
  ]
}

规则:
- categories 最多 8 条；title 不超 80 字；description 不超 150 字
- articleTypes 字符串数组最多 12 条
- subjectDistribution percent 必须 0-100 整数；最多 8 条；没数据留空数组
- 任何 unsure 字段留空数组 / 空字符串，不要瞎编`;

export async function extractScopeDetails(
  input: ScopeDetailsInput,
): Promise<ScopeDetailsShape | null> {
  if (!input.websiteHtml) return null;
  const text = extractMainText(input.websiteHtml);
  if (text.length < 200) {
    logger.debug({ journal: input.journalName }, "scope-details: 官网正文过短，跳过");
    return null;
  }

  const prompt = PROMPT_TEMPLATE(input.journalName, text);

  let raw: string;
  try {
    const resp = await chat({
      tenantId: input.tenantId,
      userId: "enricher",
      conversationId: `scope-${input.journalName}`,
      message: prompt,
      skillType: "formatting", // → Qwen-Plus 路由（model-router.ts:62）
    });
    raw = resp.content;
  } catch (err) {
    logger.warn(
      { journal: input.journalName, err: err instanceof Error ? err.message : String(err) },
      "scope-details: chat 调用失败",
    );
    return null;
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn(
      { journal: input.journalName, raw: raw.slice(0, 200) },
      "scope-details: JSON parse 失败",
    );
    return null;
  }

  const categories: ScopeCategory[] = Array.isArray(parsed.categories)
    ? parsed.categories
        .filter((c: any) => c && typeof c.title === "string" && c.title.trim())
        .slice(0, 8)
        .map((c: any) => ({
          title: String(c.title).trim().slice(0, 80),
          description:
            typeof c.description === "string" ? c.description.trim().slice(0, 150) : undefined,
        }))
    : [];

  const articleTypes: string[] = Array.isArray(parsed.articleTypes)
    ? parsed.articleTypes
        .filter((t: any) => typeof t === "string" && t.trim())
        .slice(0, 12)
        .map((t: string) => t.trim().slice(0, 80))
    : [];

  const subjectDistribution = Array.isArray(parsed.subjectDistribution)
    ? parsed.subjectDistribution
        .filter(
          (r: any) =>
            r && typeof r.subject === "string" && r.subject.trim() && Number.isFinite(r.percent),
        )
        .slice(0, 8)
        .map((r: any) => ({
          subject: String(r.subject).trim().slice(0, 60),
          percent: Math.max(0, Math.min(100, Math.round(Number(r.percent)))),
        }))
    : [];

  const submissionNote =
    typeof parsed.submissionNote === "string" ? parsed.submissionNote.trim().slice(0, 500) : "";

  // 全空 → 返回 null（partial OK 语义）
  if (
    categories.length === 0 &&
    articleTypes.length === 0 &&
    subjectDistribution.length === 0 &&
    !submissionNote
  ) {
    return null;
  }

  return {
    categories: categories.length > 0 ? categories : undefined,
    articleTypes: articleTypes.length > 0 ? articleTypes : undefined,
    submissionNote: submissionNote || undefined,
    subjectDistribution: subjectDistribution.length > 0 ? subjectDistribution : undefined,
    source: "journal_website_llm",
    lastUpdatedAt: new Date().toISOString(),
  };
}
