/**
 * T414: 选题 → 大纲 → 全文完整 Pipeline
 *
 * 基于 RAG V2 + 日历 + 热点的完整内容生产流程：
 * 1. 选题生成（热点/日历/手动）
 * 2. 大纲规划（结构化章节）
 * 3. 全文生成（分章节生成，保证质量）
 * 4. 质检 v2
 * 5. 入库
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { retrieveForArticleV2 } from "../knowledge/rag-retriever-v2.js";
import { qualityCheckV2 } from "./quality-check-v2.js";
import { db } from "../../models/db.js";
import { contents, productionRecords } from "../../models/schema.js";

// ============ 类型定义 ============

export interface TopicInput {
  topic: string;
  audience?: string;
  tone?: string;
  keywords?: string[];
  platform?: string;
  wordCount?: number;
  articleType?: string;
}

export interface OutlineSection {
  heading: string;
  points: string[];
  estimatedWords: number;
}

export interface ArticleOutline {
  title: string;
  hook: string;              // 开头钩子
  sections: OutlineSection[];
  conclusion: string;        // 结尾思路
  totalEstimatedWords: number;
  seoKeywords: string[];
}

export interface VariantResult {
  contentId: string;
  outline: ArticleOutline;
  article: { title: string; body: string; wordCount: number };
  quality: Awaited<ReturnType<typeof qualityCheckV2>>;
  variantIndex: number;       // 0 = 主版本，1+ = 副版本
}

export interface PipelineResult {
  topic: TopicInput;
  // === T4-1a 新字段：多版本支持 ===
  variants: VariantResult[];
  primaryContentId: string;
  // === 旧字段（兼容 variants=1 callers，等同于 variants[0] 拆解）===
  outline: ArticleOutline;
  article: { title: string; body: string; wordCount: number };
  quality: Awaited<ReturnType<typeof qualityCheckV2>>;
  contentId: string;
}

// ============ Pipeline 执行 ============

/**
 * 单个变体的 Pipeline (Step 1~6)
 *
 * - 主版本（variantIndex=0）的 productionRecords.parentId = null
 * - 副版本（variantIndex>0）的 productionRecords.parentId = 主版本的 contentId
 */
async function runSingleArticleVariant(
  tenantId: string,
  userId: string,
  input: TopicInput,
  parentContentId: string | null,
  variantIndex: number
): Promise<VariantResult> {
  // Step 1: RAG 检索上下文
  const ragContext = await retrieveForArticleV2({
    tenantId,
    topic: input.topic,
    audience: input.audience,
    tone: input.tone,
    keywords: input.keywords,
    platform: input.platform,
  });

  // Step 2: 生成大纲
  const outline = await generateOutline(tenantId, input, ragContext.text);

  // Step 3: 基于大纲生成全文
  const article = await generateFullArticle(tenantId, outline, input, ragContext.text);

  // Step 4: 质检 v2
  const quality = await qualityCheckV2({
    tenantId,
    title: article.title,
    body: article.body,
    platform: input.platform,
  });

  // Step 5: 质检不通过则重试一次
  let finalArticle = article;
  let finalQuality = quality;

  if (!quality.overallPassed) {
    logger.info({ variantIndex }, "质检未通过，重试生成");
    const feedback = buildQualityFeedback(quality);
    finalArticle = await generateFullArticle(tenantId, outline, input, ragContext.text, feedback);
    finalQuality = await qualityCheckV2({
      tenantId,
      title: finalArticle.title,
      body: finalArticle.body,
      platform: input.platform,
    });
  }

  // Step 6: 入库
  const [content] = await db.insert(contents).values({
    tenantId,
    userId,
    type: "article",
    title: finalArticle.title,
    body: finalArticle.body,
    status: finalQuality.overallPassed ? "reviewing" : "draft",
    metadata: {
      outline: outline.sections.map((s) => s.heading),
      qualityScore: finalQuality.totalScore,
      qualityPassed: finalQuality.overallPassed,
      ragSources: ragContext.sources,
      seoKeywords: outline.seoKeywords,
      pipeline: "article-pipeline-v2",
      variantIndex,
      ...(parentContentId ? { variantOf: parentContentId } : {}),
    },
  }).returning();

  // 生产记录（parentId 串联多版本）
  await db.insert(productionRecords).values({
    tenantId,
    contentId: content.id,
    parentId: parentContentId,
    format: "long_article",
    platform: input.platform || null,
    title: finalArticle.title,
    body: finalArticle.body,
    wordCount: finalArticle.wordCount,
    status: finalQuality.overallPassed ? "in_review" : "draft",
    producedBy: "ai",
    metadata: {
      pipelineVersion: "v2",
      ragHits: ragContext.totalHits,
      qualityScore: finalQuality.totalScore,
      variantIndex,
    },
  });

  logger.info(
    {
      contentId: content.id,
      variantIndex,
      parentContentId,
      title: finalArticle.title,
      wordCount: finalArticle.wordCount,
      qualityScore: finalQuality.totalScore,
      passed: finalQuality.overallPassed,
    },
    `📝 变体 #${variantIndex} 完成`
  );

  return {
    contentId: content.id,
    outline,
    article: finalArticle,
    quality: finalQuality,
    variantIndex,
  };
}

/**
 * 完整 Pipeline: 选题 → 大纲 → 全文 → 质检 → 入库
 *
 * 多版本支持（T4-1a）：variants 参数控制版本数（1-3，超过 3 截断到 3）。
 * - variants=1（默认）：单文章，行为与之前一致
 * - variants>1：先跑主版本拿 contentId，然后并行跑 N-1 个副版本
 *   （副版本的 productionRecords.parentId 链接到主版本 contentId）
 *   差异来源于 LLM 温度采样的随机性（同 prompt 多次跑）。
 */
export async function runArticlePipeline(
  tenantId: string,
  userId: string,
  input: TopicInput & { variants?: number }
): Promise<PipelineResult> {
  const requestedVariants = Math.min(Math.max(input.variants ?? 1, 1), 3);

  logger.info(
    { tenantId, topic: input.topic, variants: requestedVariants },
    "📝 文章 Pipeline 启动"
  );

  // 主版本必须先跑完拿到 contentId（副版本的 parentId 依赖它）
  const primary = await runSingleArticleVariant(tenantId, userId, input, null, 0);

  // 副版本并行跑
  let allVariants: VariantResult[] = [primary];
  if (requestedVariants > 1) {
    const subVariantPromises: Promise<VariantResult>[] = [];
    for (let i = 1; i < requestedVariants; i++) {
      subVariantPromises.push(
        runSingleArticleVariant(tenantId, userId, input, primary.contentId, i)
      );
    }
    const subVariants = await Promise.all(subVariantPromises);
    allVariants = [primary, ...subVariants];
  }

  return {
    topic: input,
    variants: allVariants,
    primaryContentId: primary.contentId,
    // 兼容旧 callers（等同于 variants[0] 拆解）
    outline: primary.outline,
    article: primary.article,
    quality: primary.quality,
    contentId: primary.contentId,
  };
}

// ============ Step 2: 大纲生成 ============

async function generateOutline(
  tenantId: string,
  input: TopicInput,
  ragContext: string
): Promise<ArticleOutline> {
  const wordCount = input.wordCount || 1200;

  let prompt = `你是一个内容策划专家。请为以下主题生成文章大纲。

主题: ${input.topic}
${input.audience ? `受众: ${input.audience}` : ""}
${input.articleType ? `类型: ${input.articleType}` : ""}
${input.tone ? `风格: ${input.tone}` : ""}
目标字数: ${wordCount}字`;

  if (ragContext) {
    prompt += `\n\n知识库参考：\n${ragContext.slice(0, 2000)}`;
  }

  prompt += `\n\n直接输出 JSON:
{
  "title": "文章标题（25字以内，有吸引力）",
  "hook": "开头钩子策略（用什么方式抓住读者）",
  "sections": [
    {"heading": "章节标题", "points": ["要点1", "要点2"], "estimatedWords": 300}
  ],
  "conclusion": "结尾思路",
  "seoKeywords": ["关键词1", "关键词2", "关键词3"]
}

要求:
- 3-6个章节
- 总字数接近 ${wordCount}
- 逻辑递进，结构清晰
- 每个章节有 2-4 个具体要点`;

  const response = await chat({
    tenantId,
    userId: "system",
    conversationId: "article-outline",
    message: prompt,
    skillType: "content_generation",
  });

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title || input.topic,
        hook: parsed.hook || "直接切入主题",
        sections: (parsed.sections || []).map((s: any) => ({
          heading: s.heading || "",
          points: s.points || [],
          estimatedWords: s.estimatedWords || 200,
        })),
        conclusion: parsed.conclusion || "总结全文",
        totalEstimatedWords: (parsed.sections || []).reduce(
          (sum: number, s: any) => sum + (s.estimatedWords || 200), 0
        ),
        seoKeywords: parsed.seoKeywords || [],
      };
    }
  } catch {}

  // 兜底大纲
  return {
    title: input.topic,
    hook: "提问式开头",
    sections: [
      { heading: "引言", points: ["背景介绍"], estimatedWords: 200 },
      { heading: "核心内容", points: ["主要论点"], estimatedWords: 600 },
      { heading: "总结", points: ["要点回顾"], estimatedWords: 200 },
    ],
    conclusion: "总结与展望",
    totalEstimatedWords: wordCount,
    seoKeywords: input.keywords || [],
  };
}

// ============ Step 3: 全文生成 ============

async function generateFullArticle(
  tenantId: string,
  outline: ArticleOutline,
  input: TopicInput,
  ragContext: string,
  qualityFeedback?: string
): Promise<{ title: string; body: string; wordCount: number }> {
  const outlineText = outline.sections
    .map((s, i) => `${i + 1}. ${s.heading}\n   要点: ${s.points.join("、")}\n   字数: ~${s.estimatedWords}字`)
    .join("\n");

  let prompt = `你是一个专业的学术自媒体写手。请按照大纲生成完整文章。

标题: ${outline.title}
开头策略: ${outline.hook}
SEO关键词: ${outline.seoKeywords.join("、")}

大纲:
${outlineText}

结尾思路: ${outline.conclusion}

${input.tone ? `风格: ${input.tone}` : ""}
${input.audience ? `受众: ${input.audience}` : ""}`;

  if (ragContext) {
    prompt += `\n\n知识库参考（请自然融入）：\n${ragContext.slice(0, 2000)}`;
  }

  if (qualityFeedback) {
    prompt += `\n\n上次质检反馈，请改进：\n${qualityFeedback}`;
  }

  prompt += `\n\n要求:
- Markdown 格式，每章节用 ## 标题
- 开头 3 句话必须抓住读者
- 自然融入 SEO 关键词
- 数据和案例支撑论点
- 结尾有 CTA（引导关注/评论）
- 总字数接近 ${input.wordCount || 1200} 字

直接输出文章正文（Markdown），不要 JSON 包裹。`;

  const response = await chat({
    tenantId,
    userId: "system",
    conversationId: "article-generate",
    message: prompt,
    skillType: "content_generation",
  });

  return {
    title: outline.title,
    body: response.content,
    wordCount: response.content.length,
  };
}

// ============ 工具 ============

function buildQualityFeedback(quality: Awaited<ReturnType<typeof qualityCheckV2>>): string {
  const parts: string[] = [];

  if (quality.totalScore < 70) {
    parts.push(`总分 ${quality.totalScore}/100，需要提升整体质量`);
  }
  if (!quality.redlineCheck.passed) {
    parts.push(`红线违规: ${quality.redlineCheck.violations.map((v) => v.rule).join("、")}`);
  }
  if (quality.styleCheck.consistency < 60) {
    parts.push(`风格偏差: ${quality.styleCheck.deviations.join("、")}`);
  }
  if (!quality.platformCheck.passed) {
    parts.push(`平台问题: ${quality.platformCheck.issues.join("、")}`);
  }

  return parts.join("\n");
}
