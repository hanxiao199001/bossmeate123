/**
 * T409 + T410: 内容复用改写 + 全链路生产记录
 *
 * T409: 跨平台改写 / 系列延伸 / 形式变体
 * T410: 生产全链路记录（Sub-lib 11 productionRecords）
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { db } from "../../models/db.js";
import { contents, productionRecords } from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import type { ContentFormat, GeneratedContent } from "./format-generators.js";
import { generateByFormat } from "./format-generators.js";

// ============ 类型定义 ============

export type RepurposeType =
  | "platform_adapt"    // 跨平台适配
  | "format_convert"    // 形式转换（长文→短视频脚本）
  | "series_extend"     // 系列延伸（上篇→下篇/番外）
  | "summary"           // 精华摘要
  | "localize";         // 语气/受众调整

export interface RepurposeRequest {
  tenantId: string;
  userId: string;
  sourceContentId: string;       // 原始内容 ID
  type: RepurposeType;
  targetFormat?: ContentFormat;   // 目标形式
  targetPlatform?: string;        // 目标平台
  instructions?: string;          // 额外指令
}

export interface RepurposeResult {
  original: { id: string; title: string; format: string };
  derived: GeneratedContent;
  productionRecordId: string;
}

// ============ 核心逻辑 ============

/**
 * 内容复用改写
 */
export async function repurposeContent(
  req: RepurposeRequest
): Promise<RepurposeResult | null> {
  const { tenantId, userId, sourceContentId, type, targetFormat, targetPlatform } = req;

  logger.info({ tenantId, sourceContentId, type, targetFormat }, "♻️ 内容复用改写");

  // 1. 获取原始内容
  const [source] = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, sourceContentId), eq(contents.tenantId, tenantId)))
    .limit(1);

  if (!source || !source.body) {
    logger.warn({ sourceContentId }, "原始内容不存在");
    return null;
  }

  // 2. 根据复用类型生成 prompt
  const prompt = buildRepurposePrompt(type, {
    title: source.title || "",
    body: source.body,
    targetFormat,
    targetPlatform,
    instructions: req.instructions,
  });

  // 3. AI 生成
  const response = await chat({
    tenantId,
    userId,
    conversationId: `repurpose-${type}`,
    message: prompt,
    skillType: "content_generation",
  });

  // 4. 解析结果
  let parsed: Record<string, unknown> = {};
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {}

  const derived: GeneratedContent = {
    format: targetFormat || (source.type as ContentFormat) || "article",
    title: (parsed.title as string) || `[改写] ${source.title}`,
    body: (parsed.body as string) || response.content,
    metadata: {
      repurposeType: type,
      sourceContentId,
      sourceTitle: source.title,
      targetPlatform,
    },
    wordCount: ((parsed.body as string) || response.content).length,
  };

  // 5. 写入生产记录（T410: Sub-lib 11）
  const [record] = await db.insert(productionRecords).values({
    tenantId,
    contentId: sourceContentId,
    parentId: sourceContentId,    // 衍生关系
    format: derived.format,
    platform: targetPlatform || null,
    title: derived.title,
    body: derived.body,
    wordCount: derived.wordCount,
    status: "draft",
    producedBy: "ai",
    tokensUsed: response.inputTokens + response.outputTokens,
    metadata: {
      repurposeType: type,
      sourceTitle: source.title,
      instructions: req.instructions,
    },
  }).returning();

  logger.info(
    {
      sourceId: sourceContentId,
      derivedTitle: derived.title,
      type,
      recordId: record.id,
    },
    "♻️ 内容复用完成"
  );

  return {
    original: { id: source.id, title: source.title || "", format: source.type },
    derived,
    productionRecordId: record.id,
  };
}

/**
 * 获取内容的衍生链（全链路追踪）
 */
export async function getDerivationChain(
  tenantId: string,
  contentId: string
): Promise<Array<{
  id: string;
  title: string | null;
  format: string;
  parentId: string | null;
  status: string;
  producedBy: string | null;
  createdAt: Date;
}>> {
  // 获取所有相关的生产记录（向下查找衍生）
  const records = await db
    .select()
    .from(productionRecords)
    .where(eq(productionRecords.tenantId, tenantId));

  // 构建衍生链
  const chain: typeof records = [];
  const queue = [contentId];
  const visited = new Set<string>();

  // BFS 查找所有衍生内容
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    for (const record of records) {
      if (record.contentId === currentId || record.parentId === currentId) {
        if (!visited.has(record.id)) {
          chain.push(record);
          queue.push(record.id);
        }
      }
    }
  }

  return chain.map((r) => ({
    id: r.id,
    title: r.title,
    format: r.format,
    parentId: r.parentId,
    status: r.status,
    producedBy: r.producedBy,
    createdAt: r.createdAt,
  }));
}

// ============ Prompt 构建 ============

function buildRepurposePrompt(
  type: RepurposeType,
  params: {
    title: string;
    body: string;
    targetFormat?: ContentFormat;
    targetPlatform?: string;
    instructions?: string;
  }
): string {
  const { title, body, targetFormat, targetPlatform, instructions } = params;
  const bodyPreview = body.slice(0, 3000);

  const base = `原文标题: ${title}\n原文内容（前3000字）:\n${bodyPreview}`;

  const prompts: Record<RepurposeType, string> = {
    platform_adapt: `请将以下内容改写为适合 ${targetPlatform || "小红书"} 平台的格式。

${base}

要求：
- 符合 ${targetPlatform || "小红书"} 的内容调性和格式规范
- 保留核心信息，调整表达方式
- 添加平台特有的互动元素

输出 JSON: {"title":"新标题","body":"改写后的内容"}`,

    format_convert: `请将以下图文内容转换为 ${targetFormat || "short_video"} 格式。

${base}

输出 JSON: {"title":"新标题","body":"转换后的内容"}`,

    series_extend: `以下是系列内容的第一篇，请创作后续延伸内容。

${base}

要求：
- 延续相同的主题和风格
- 深入新的角度或子话题
- 有前文回顾和衔接

输出 JSON: {"title":"续篇标题","body":"续篇内容"}`,

    summary: `请将以下长文浓缩为精华摘要版本（500字以内）。

${base}

输出 JSON: {"title":"摘要标题","body":"精华摘要"}`,

    localize: `请调整以下内容的语气和受众定位。
${instructions ? `调整要求: ${instructions}` : "改为更通俗易懂的表达"}

${base}

输出 JSON: {"title":"调整后标题","body":"调整后内容"}`,
  };

  return prompts[type];
}
