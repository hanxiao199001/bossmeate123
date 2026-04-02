/**
 * T403: 8 种内容形式生成器
 *
 * 基于 RAG V2 检索 + AI 生成，支持：
 * 1. 口播文案 (spoken)       — 短视频/直播用
 * 2. 图文文章 (article)      — 公众号/知乎长文
 * 3. 视频脚本 (video_script)  — 分镜+旁白+字幕
 * 4. 信息图 (infographic)    — 数据可视化文案
 * 5. 长图文 (long_graphic)   — 小红书/朋友圈图文
 * 6. 短视频 (short_video)    — 15-60秒脚本
 * 7. 音频脚本 (audio)        — 播客/音频节目
 * 8. 互动内容 (interactive)  — 投票/问答/测评
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { retrieveForArticleV2 } from "../knowledge/rag-retriever-v2.js";
import { db } from "../../models/db.js";
import { productionRecords } from "../../models/schema.js";

// ============ 类型定义 ============

export type ContentFormat =
  | "spoken"
  | "article"
  | "video_script"
  | "infographic"
  | "long_graphic"
  | "short_video"
  | "audio"
  | "interactive";

export const FORMAT_LABELS: Record<ContentFormat, string> = {
  spoken: "口播文案",
  article: "图文文章",
  video_script: "视频脚本",
  infographic: "信息图文案",
  long_graphic: "长图文",
  short_video: "短视频脚本",
  audio: "音频脚本",
  interactive: "互动内容",
};

export interface GenerateRequest {
  tenantId: string;
  userId: string;
  topic: string;
  format: ContentFormat;
  audience?: string;
  tone?: string;
  keywords?: string[];
  platform?: string;
  wordCount?: number;
  extraRequirements?: string;
}

export interface GeneratedContent {
  format: ContentFormat;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  wordCount: number;
}

// ============ 各形式 prompt 模板 ============

const FORMAT_PROMPTS: Record<ContentFormat, (req: GenerateRequest) => string> = {
  spoken: (req) => `你是一个短视频口播文案专家。

请为以下主题撰写口播文案：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}
${req.platform ? `平台: ${req.platform}` : ""}

要求:
- 开头3秒必须有钩子（提问/数据冲击/反常识）
- 口语化，像跟朋友聊天
- 每段不超过3句话
- 总时长控制在60-90秒（约300-450字）
- 结尾有明确的 CTA

输出 JSON:
{"title":"标题","body":"口播全文（含分段标记）","duration":"预估时长","hooks":["钩子1"]}`,

  article: (req) => `你是一个专业的学术自媒体撰稿人。

请撰写一篇图文文章：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}
字数: ${req.wordCount || 1200}字左右
${req.tone ? `风格: ${req.tone}` : ""}

要求:
- Markdown 格式
- 有吸引力的标题
- 清晰的结构（小标题分段）
- 数据和案例支撑论点
- 结尾有总结和互动引导

输出 JSON:
{"title":"标题","body":"正文(Markdown)","summary":"一句话摘要","tags":["标签1","标签2"]}`,

  video_script: (req) => `你是一个视频脚本编剧。

请为以下主题创作视频脚本：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}
时长: ${req.wordCount ? Math.round(req.wordCount / 5) + "秒" : "3-5分钟"}

要求:
- 分镜格式：【画面描述】+旁白+字幕
- 开头15秒必须抓住注意力
- 转场自然
- 结尾有 CTA

输出 JSON:
{"title":"视频标题","body":"分镜脚本(每个镜头换行)","scenes":5,"duration":"预估时长"}`,

  infographic: (req) => `你是一个信息图文案策划专家。

请为以下主题设计信息图文案：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}

要求:
- 提取 5-8 个核心数据点
- 每个数据点配一句解读
- 整体逻辑：问题→数据→结论
- 适合可视化呈现

输出 JSON:
{"title":"信息图标题","body":"数据点列表(每行一个)","dataPoints":[{"value":"数据","label":"说明"}],"conclusion":"总结语"}`,

  long_graphic: (req) => `你是一个小红书/朋友圈长图文策划专家。

请为以下主题创作长图文：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}
${req.platform ? `平台: ${req.platform}` : "小红书"}

要求:
- 分 6-10 张图的文案
- 每张图文字控制在 50-80 字
- 第一张是封面标题（要有冲击力）
- 最后一张是 CTA
- emoji 适量使用
- 干货+实操为主

输出 JSON:
{"title":"封面标题","body":"全部图文(用---分隔每张图)","slideCount":8}`,

  short_video: (req) => `你是一个 15-60 秒短视频脚本专家。

请创作短视频脚本：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}
时长: 30-60秒

要求:
- 黄金3秒开头（必须有钩子）
- 节奏快，信息密度高
- 适合竖屏拍摄
- 明确的转场和节奏标记
- 结尾引导关注/评论

输出 JSON:
{"title":"标题","body":"脚本(含时间标记如[0-3s])","duration":"预估秒数","hooks":["钩子"]}`,

  audio: (req) => `你是一个播客/音频节目编剧。

请为以下主题创作音频脚本：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}
时长: ${req.wordCount ? Math.round(req.wordCount / 3) + "秒" : "5-10分钟"}

要求:
- 开场白要亲切自然
- 像讲故事一样展开
- 适当设置悬念和停顿
- 语气标记（强调/停顿/语气词）
- 结尾有总结和预告

输出 JSON:
{"title":"节目标题","body":"音频脚本(含语气标记)","duration":"预估时长","segments":["段落主题1","段落主题2"]}`,

  interactive: (req) => `你是一个互动内容策划专家。

请为以下主题创作互动内容：
主题: ${req.topic}
${req.audience ? `受众: ${req.audience}` : ""}

要求:
- 包含至少一种互动形式：投票/问答/测评/挑战
- 吸引用户参与和评论
- 有知识增量
- 结合热点或争议话题
- 设计结果解读

输出 JSON:
{"title":"互动标题","body":"互动内容全文","interactionType":"投票|问答|测评|挑战","questions":[{"q":"问题","options":["选项1","选项2"]}]}`,
};

// ============ 核心生成 ============

/**
 * 根据指定格式生成内容
 */
export async function generateByFormat(req: GenerateRequest): Promise<GeneratedContent> {
  const { tenantId, format, topic } = req;
  const formatLabel = FORMAT_LABELS[format];

  logger.info({ tenantId, format, topic }, `📝 开始生成: ${formatLabel}`);

  // 1. RAG 检索上下文
  const ragContext = await retrieveForArticleV2({
    tenantId,
    topic,
    audience: req.audience,
    tone: req.tone,
    keywords: req.keywords,
    platform: req.platform,
    tokenBudget: 3000,
  });

  // 2. 构建 prompt
  const formatPrompt = FORMAT_PROMPTS[format](req);
  let fullPrompt = formatPrompt;
  if (ragContext.text) {
    fullPrompt += `\n\n以下是知识库参考资料，请适当引用：\n${ragContext.text}`;
  }
  if (req.extraRequirements) {
    fullPrompt += `\n\n额外要求：${req.extraRequirements}`;
  }

  // 3. AI 生成
  const response = await chat({
    tenantId,
    userId: req.userId,
    conversationId: `format-gen-${format}`,
    message: fullPrompt,
    skillType: "content_generation",
  });

  // 4. 解析结果
  let parsed: Record<string, unknown> = {};
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch {
    // JSON 解析失败，用原文
  }

  const result: GeneratedContent = {
    format,
    title: (parsed.title as string) || topic,
    body: (parsed.body as string) || response.content,
    metadata: {
      ...parsed,
      ragSources: ragContext.sources,
      ragHits: ragContext.totalHits,
      ragTokens: ragContext.totalTokens,
      aiModel: response.model,
      aiProvider: response.provider,
    },
    wordCount: ((parsed.body as string) || response.content).length,
  };

  // 5. 记录生产记录 (Sub-lib 11)
  try {
    await db.insert(productionRecords).values({
      tenantId,
      format,
      platform: req.platform || null,
      title: result.title,
      body: result.body,
      wordCount: result.wordCount,
      status: "draft",
      producedBy: "ai",
      tokensUsed: response.inputTokens + response.outputTokens,
      metadata: result.metadata,
    });
  } catch (err) {
    logger.warn({ err }, "生产记录写入失败");
  }

  logger.info(
    { format, title: result.title, wordCount: result.wordCount },
    `📝 ${formatLabel}生成完成`
  );

  return result;
}

/**
 * 批量生成多种形式（同一主题）
 */
export async function generateMultiFormat(
  req: Omit<GenerateRequest, "format">,
  formats: ContentFormat[]
): Promise<GeneratedContent[]> {
  const results: GeneratedContent[] = [];

  for (const format of formats) {
    try {
      const content = await generateByFormat({ ...req, format });
      results.push(content);
    } catch (err) {
      logger.error({ err, format }, "多形式生成失败");
    }
  }

  return results;
}
