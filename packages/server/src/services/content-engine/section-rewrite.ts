/**
 * 章节级重写（T4-2-1）
 *
 * 用途：把"AI 生成的整篇文章 → 老板手改"的人机协作流，从"全文重写"压缩到"章节级精修"。
 *   1. splitByH2(body)              —— 按 Markdown `## ` 切章节
 *   2. rewriteSection({...})        —— 老板指定章节 + 重写指令 → AI 在前后章节上下文里重写
 *   3. （路由层）apply-rewrite      —— 老板预览 OK 后落库 + 写 bossEdits（学习偏好）
 *
 * 设计取舍：
 * - 纯函数：splitByH2 / 上下文截取无副作用，rewriteSection 不写库（仅预览）
 * - 模糊 heading 匹配：老板可能写"一、肿瘤学..."或"## 一、肿瘤学..."，都接受
 * - 上下文裁剪到 200 字：避免长文导致 prompt 过长 / 超时；连贯性所需信号已足够
 * - DeepSeek-Reasoner（quality_check primary）：精修属重逻辑场景；不用 cheap 模型
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { getProviderByName } from "../ai/provider-factory.js";

export interface SectionInfo {
  /** 完整 heading 行，例如 `## 一、肿瘤学投稿现状` */
  heading: string;
  /** 去掉 `## ` 前缀后的标题文字 */
  headingText: string;
  /** 章节正文（不含 heading 行） */
  content: string;
  /** heading 行所在行号（0-based） */
  startLine: number;
  /** 章节最后一行行号（0-based，含） */
  endLine: number;
}

const H2_REGEX = /^##\s+(.+?)\s*$/;

/**
 * 按 `## ` 切章节。`## ` 之前的内容（preamble）不返回。
 * - 同一章节包含 heading 行本身 + 后续直到下一个 `## ` 或文末
 * - 没有 `## ` 时返回空数组
 */
export function splitByH2(body: string): SectionInfo[] {
  const lines = (body || "").split("\n");
  const sections: SectionInfo[] = [];

  let cur: { heading: string; headingText: string; startLine: number; bodyStart: number } | null =
    null;

  const close = (endLine: number) => {
    if (!cur) return;
    const contentLines = lines.slice(cur.bodyStart, endLine + 1);
    sections.push({
      heading: cur.heading,
      headingText: cur.headingText,
      content: contentLines.join("\n"),
      startLine: cur.startLine,
      endLine,
    });
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(H2_REGEX);
    if (m) {
      close(i - 1);
      cur = {
        heading: lines[i],
        headingText: m[1].trim(),
        startLine: i,
        bodyStart: i + 1,
      };
    }
  }
  close(lines.length - 1);

  return sections;
}

/** 标题模糊比较：去掉 `## ` 前缀 + 去首尾空白后小写比对 */
function normalizeHeading(s: string): string {
  return s
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
}

function findSection(sections: SectionInfo[], target: string): SectionInfo | null {
  const norm = normalizeHeading(target);
  if (!norm) return null;
  // 1. 先尝试完全相等（headingText 或 heading 行原文）
  for (const s of sections) {
    if (s.heading === target || s.headingText === target) return s;
  }
  // 2. 模糊：normalize 后相等
  for (const s of sections) {
    if (normalizeHeading(s.heading) === norm || normalizeHeading(s.headingText) === norm) {
      return s;
    }
  }
  // 3. 包含匹配（兜底，老板写"肿瘤学投稿"匹配"一、肿瘤学投稿现状"）
  for (const s of sections) {
    const h = normalizeHeading(s.headingText);
    if (h.includes(norm) || norm.includes(h)) return s;
  }
  return null;
}

export interface RewriteSectionInput {
  tenantId: string;
  contentId: string;
  /** 老板指定的章节标题（可含 / 不含 `## ` 前缀，模糊匹配） */
  sectionHeading: string;
  /** 老板指令，例如 "这段太啰嗦，改成 3 句话" */
  instruction: string;
}

export interface RewriteSectionResult {
  original: { heading: string; body: string; startLine: number; endLine: number };
  rewritten: { heading: string; body: string };
  context: { previousSection: string | null; nextSection: string | null };
  durationMs: number;
  tokensUsed: number;
}

/**
 * AI 重写指定章节 —— 不写库，仅返回预览结果。
 * 上层（路由）拿到结果后给老板看 diff，确认才走 apply-rewrite 落库。
 */
export async function rewriteSection(
  input: RewriteSectionInput
): Promise<RewriteSectionResult> {
  const start = Date.now();

  // 1. 读 content（按 contentId + tenantId 隔离）
  const [content] = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, input.contentId), eq(contents.tenantId, input.tenantId)))
    .limit(1);
  if (!content) {
    throw new Error("content_not_found");
  }
  const body = content.body || "";

  // 2. 切章节并匹配
  const sections = splitByH2(body);
  if (sections.length === 0) {
    throw new Error("no_h2_sections");
  }
  const target = findSection(sections, input.sectionHeading);
  if (!target) {
    throw new Error("section_not_found");
  }

  const targetIdx = sections.findIndex((s) => s.startLine === target.startLine);
  const prev = targetIdx > 0 ? sections[targetIdx - 1] : null;
  const next = targetIdx < sections.length - 1 ? sections[targetIdx + 1] : null;

  const previousSection = prev ? prev.content.slice(-200) : null;
  const nextSection = next ? next.content.slice(0, 200) : null;

  // 3. 构 prompt
  const systemPrompt = `你是写作助手。根据老板指令重写指定章节，必须保持上下文连贯。

原文章节：
${target.heading}
${target.content}

上文（前一章节最后 200 字）：
${previousSection || "（这是开头章节）"}

下文（后一章节前 200 字）：
${nextSection || "（这是结尾章节）"}

老板指令：${input.instruction}

要求：
1. 只重写指定章节，保持 \`${target.heading}\` 文字完全不变
2. 与上下文逻辑连贯（不重复上文，不剧透下文）
3. 字数与原章节接近（±20%）
4. 保留 Markdown 格式（列表 / 引用 / 链接 / 加粗）
5. 直接输出新章节内容（含 ## 标题），不要包 JSON、不要解释、不要多余前后缀

输出格式：
${target.heading}
新版正文...`;

  // 4. 调 AI（DeepSeek-Reasoner，对应 modelRouter quality_check primary）
  const provider = getProviderByName("deepseek");
  if (!provider) {
    throw new Error("no_ai_provider");
  }

  let aiContent: string;
  let tokensUsed = 0;
  try {
    const res = await provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input.instruction },
      ],
      model: env.DEEPSEEK_MODEL_REASONER,
      temperature: 0.5,
    });
    aiContent = res.content || "";
    tokensUsed = (res.inputTokens || 0) + (res.outputTokens || 0);
  } catch (err) {
    logger.error(
      { err, contentId: input.contentId, tenantId: input.tenantId },
      "T4-2-1: 章节重写 AI 调用失败"
    );
    throw err;
  }

  // 5. 解析 AI 输出 —— 期望第一行是 heading，其余是正文
  const aiLines = aiContent.split("\n");
  let rewrittenHeading = target.heading;
  let rewrittenBodyStart = 0;
  for (let i = 0; i < aiLines.length; i++) {
    if (H2_REGEX.test(aiLines[i])) {
      rewrittenHeading = aiLines[i];
      rewrittenBodyStart = i + 1;
      break;
    }
  }
  // 若 AI 没输出 ## heading（违反指令），整段当 body，heading 沿用原文
  const rewrittenBody = aiLines.slice(rewrittenBodyStart).join("\n").trim();

  return {
    original: {
      heading: target.heading,
      body: target.content,
      startLine: target.startLine,
      endLine: target.endLine,
    },
    rewritten: {
      heading: rewrittenHeading,
      body: rewrittenBody,
    },
    context: { previousSection, nextSection },
    durationMs: Date.now() - start,
    tokensUsed,
  };
}
