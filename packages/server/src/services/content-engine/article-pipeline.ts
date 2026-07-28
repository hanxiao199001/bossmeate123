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
import { qualityCheckV2, QUALITY_GATE_UNAVAILABLE_REASON } from "./quality-check-v2.js";
import { runArticleQualityPasses, qualityPipelineMeta, type QualityPipelineResult } from "./quality-pipeline.js";
import { buildHookPromptBlock } from "../../data/hook-patterns.js";
import { buildClicheBanPrompt } from "../../data/ai-cliche.js";
import { env } from "../../config/env.js";
import { db } from "../../models/db.js";
import { contents, productionRecords } from "../../models/schema.js";
import { initialStatusFields } from "../articles/state-machine.js";

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

  // Step 4: P0四件套流水线（④压缩 → ③去AI腔 → ①六维质检 → 未过→定向重写循环）
  // 老的"整文重试一次"被定向重写闭环取代：只重写低分维度的 weakestSection，省 token 且不推倒重来
  let qp: QualityPipelineResult | null = null;
  let finalArticle = article;
  try {
    qp = await runArticleQualityPasses({
      tenantId,
      userId,
      title: article.title,
      body: article.body,
    });
    finalArticle = { ...article, body: qp.body, wordCount: qp.body.length };
  } catch (err) {
    logger.warn({ err, variantIndex }, "P0四件套流水线失败(非阻塞), 用原文继续");
  }

  // Step 5: 完整质检 v2（红线/风格/平台照旧；六维分复用流水线结果，不重复打分）
  const finalQuality = await qualityCheckV2({
    tenantId,
    title: finalArticle.title,
    body: finalArticle.body,
    platform: input.platform,
    precomputedSixDim: qp?.sixDim ?? undefined,
  });

  // Step 6: 入库
  const [content] = await db.insert(contents).values({
    tenantId,
    userId,
    type: "article",
    title: finalArticle.title,
    body: finalArticle.body,
    // P0-A2：质检通过 → 'generated'（旧 reviewing 映射），未过 → 'draft'
    ...initialStatusFields(finalQuality.overallPassed ? "generated" : "needs_review"), // PR-U2 质检未过→待审
    metadata: {
      outline: outline.sections.map((s) => s.heading),
      qualityScore: finalQuality.totalScore,
      qualityPassed: finalQuality.overallPassed,
      ragSources: ragContext.sources,
      seoKeywords: outline.seoKeywords,
      pipeline: "article-pipeline-v2",
      // 7-28 ②a: 哪几道闸没跑成, 无论过没过都留痕(排查用)
      ...(finalQuality.unavailableChecks?.length ? { unavailableChecks: finalQuality.unavailableChecks } : {}),
      // 因"闸没检查成"而没过 → 原因必须写清: draft-distributor 靠 needsReviewReason 区分
      //   "红线剔除"与"排队尾"。写成红线类会把只是检查器挂了的内容永久打死(7-27 事故复刻);
      //   不写则退化成普通"质量不过", 丢掉"该复核什么"的信息。
      ...(!finalQuality.overallPassed && finalQuality.unavailableChecks?.length
        ? { needsReview: true, needsReviewReason: QUALITY_GATE_UNAVAILABLE_REASON }
        : {}),
      // P0四件套: 六维分/重写轮数/压缩/去AI腔 全量落 metadata, 管理端可见低分文章
      ...(qp ? qualityPipelineMeta(qp) : {}),
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

  // P0②: 注入钩子模式库（按 articleType 随机挑 3 个），hook 字段必须从中选
  if (env.ARTICLE_HOOK_INJECT !== "false") {
    prompt += buildHookPromptBlock(input.articleType);
    prompt += `\n（"hook" 字段必须写明选了哪个钩子模式以及开头前两句的具体写法）`;
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

  // P0②③预防: 钩子模式 + AI 腔禁用清单（生成端先防，生成后还有 decliche 清洗兜底）
  if (env.ARTICLE_HOOK_INJECT !== "false") {
    prompt += buildHookPromptBlock(input.articleType);
  }
  prompt += buildClicheBanPrompt(20);

  prompt += `\n\n要求:
- Markdown 格式，每章节用 ## 标题
- 开头 3 句话必须抓住读者
- 自然融入 SEO 关键词
- 数据和案例支撑论点
- 不得编造期刊的影响因子、分区、录用率、审稿周期等具体数字；只能引用"知识库参考"中明确给出的数值，没有就不写具体数字（可定性表述，如"影响力较高""审稿较快"）
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
