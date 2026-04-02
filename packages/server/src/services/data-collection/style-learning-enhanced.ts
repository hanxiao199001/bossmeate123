/**
 * T307: IP 风格自动学习增强
 *
 * 增强现有 style-learner.ts，新增：
 * - 已发布内容自动风格提取 → Sub-lib 8（IP 风格模板库）
 * - 跨平台风格一致性检测
 * - 风格漂移告警
 * - 与竞品风格差异化分析
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { db } from "../../models/db.js";
import {
  contents,
  distributionRecords,
  styleAnalyses,
  learnedTemplates,
} from "../../models/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { ingestToKnowledge } from "./ingest-pipeline.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型定义 ============

export interface StyleFeature {
  titlePattern: string;       // 标题公式
  openingHook: string;        // 开头钩子类型
  tone: string;               // 语气调性
  structure: string;          // 内容结构
  signatureExpressions: string[];  // 标志性表达
  visualStyle: string;        // 排版视觉风格
  ctaStyle: string;           // CTA 风格
}

export interface StyleDrift {
  dimension: string;
  before: string;
  after: string;
  severity: "low" | "medium" | "high";
}

export interface StyleLearningResult {
  features: StyleFeature[];
  templatesCreated: number;
  knowledgeIngested: number;
  drifts: StyleDrift[];
}

// ============ 核心逻辑 ============

/**
 * 自动风格学习（调度器入口）
 */
export async function autoLearnStyle(
  tenantId: string
): Promise<StyleLearningResult> {
  logger.info({ tenantId }, "🎨 开始 IP 风格自动学习");

  // 1. 获取已发布的内容
  const publishedContents = await db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.tenantId, tenantId),
        eq(contents.status, "published")
      )
    )
    .orderBy(desc(contents.updatedAt))
    .limit(30);

  if (publishedContents.length < 3) {
    logger.info("已发布内容不足 3 篇，跳过风格学习");
    return { features: [], templatesCreated: 0, knowledgeIngested: 0, drifts: [] };
  }

  // 2. AI 提取风格特征
  const features = await extractStyleFeatures(publishedContents, tenantId);

  // 3. 风格特征 → Sub-lib 8
  let knowledgeIngested = 0;
  if (features.length > 0) {
    const result = await ingestStyleToKnowledge(features, tenantId);
    knowledgeIngested = result.ingested;
  }

  // 4. 自动生成/更新模板
  const templatesCreated = await updateTemplatesFromFeatures(features, tenantId);

  // 5. 风格漂移检测
  const drifts = await detectStyleDrift(features, tenantId);

  logger.info(
    {
      tenantId,
      featuresExtracted: features.length,
      templatesCreated,
      knowledgeIngested,
      driftsDetected: drifts.length,
    },
    "🎨 IP 风格学习完成"
  );

  return { features, templatesCreated, knowledgeIngested, drifts };
}

// ============ 风格提取 ============

async function extractStyleFeatures(
  publishedContents: Array<{
    id: string;
    title: string | null;
    body: string | null;
    type: string;
  }>,
  tenantId: string
): Promise<StyleFeature[]> {
  // 取最近的 10 篇有正文的内容做分析
  const validContents = publishedContents
    .filter((c) => c.body && c.body.length > 200)
    .slice(0, 10);

  if (validContents.length === 0) return [];

  const titles = validContents.map((c) => c.title).filter(Boolean).join("\n");
  const openings = validContents
    .map((c) => c.body!.slice(0, 300))
    .join("\n---\n");

  const prompt = `你是一个内容风格分析专家。分析以下已发布内容的风格特征。

标题列表:
${titles}

文章开头（每篇前300字）:
${openings}

请提取 2-3 种风格模式，直接输出 JSON 数组:
[
  {
    "titlePattern": "标题公式（如：数字+痛点+解决方案）",
    "openingHook": "开头钩子类型（如：数据冲击/故事引入/直接提问）",
    "tone": "语气调性（如：专业权威/亲切对话/犀利辛辣）",
    "structure": "内容结构（如：问题→分析→方案→CTA）",
    "signatureExpressions": ["标志性表达1", "标志性表达2"],
    "visualStyle": "排版风格描述",
    "ctaStyle": "CTA风格（如：关注引导/评论互动/转发收藏）"
  }
]`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "style-learning",
      message: prompt,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    return JSON.parse(jsonMatch[0]) as StyleFeature[];
  } catch (err) {
    logger.error({ err }, "风格特征提取失败");
    return [];
  }
}

// ============ 入库 Sub-lib 8 ============

async function ingestStyleToKnowledge(
  features: StyleFeature[],
  tenantId: string
): Promise<{ ingested: number; rejected: number }> {
  const items = features.map((f, i) => ({
    title: `IP风格模式${i + 1}: ${f.tone}`,
    content: [
      `IP风格模板 - ${f.tone}`,
      ``,
      `标题公式: ${f.titlePattern}`,
      `开头钩子: ${f.openingHook}`,
      `语气调性: ${f.tone}`,
      `内容结构: ${f.structure}`,
      `标志性表达: ${f.signatureExpressions.join("、")}`,
      `排版风格: ${f.visualStyle}`,
      `CTA风格: ${f.ctaStyle}`,
    ].join("\n"),
    category: "style" as VectorCategory,
    source: "style-learning:auto",
    metadata: {
      titlePattern: f.titlePattern,
      tone: f.tone,
      learnedAt: new Date().toISOString(),
    },
  }));

  return ingestToKnowledge(items, tenantId);
}

// ============ 模板更新 ============

async function updateTemplatesFromFeatures(
  features: StyleFeature[],
  tenantId: string
): Promise<number> {
  let created = 0;

  for (const feature of features) {
    try {
      // 生成模板的 prompt 指令
      const stylePrompt = [
        `语气: ${feature.tone}`,
        `结构: ${feature.structure}`,
        `开头: 使用${feature.openingHook}式开头`,
        `标志性表达: ${feature.signatureExpressions.join("、")}`,
        `CTA: ${feature.ctaStyle}`,
      ].join("\n");

      await db.insert(learnedTemplates).values({
        tenantId,
        name: `自动学习-${feature.tone}`,
        desc: `基于已发布内容自动学习的${feature.tone}风格模板`,
        icon: "🎨",
        source: "ai_generated",
        sections: JSON.stringify([
          { name: "开头", desc: feature.openingHook },
          { name: "正文", desc: feature.structure },
          { name: "结尾", desc: feature.ctaStyle },
        ]),
        titleFormula: feature.titlePattern,
        styleTags: JSON.stringify([feature.tone, feature.openingHook]),
        prompt: stylePrompt,
        isActive: true,
      });

      created++;
    } catch (err) {
      // 可能重复，忽略
      logger.debug({ err, tone: feature.tone }, "模板创建跳过");
    }
  }

  return created;
}

// ============ 风格漂移检测 ============

async function detectStyleDrift(
  currentFeatures: StyleFeature[],
  tenantId: string
): Promise<StyleDrift[]> {
  // 获取上次的风格分析结果
  const lastAnalysis = await db
    .select()
    .from(styleAnalyses)
    .where(
      and(
        eq(styleAnalyses.tenantId, tenantId),
        eq(styleAnalyses.source, "self")
      )
    )
    .orderBy(desc(styleAnalyses.updatedAt))
    .limit(1);

  if (lastAnalysis.length === 0 || currentFeatures.length === 0) {
    return [];
  }

  const prev = lastAnalysis[0];
  const prevStyle = prev.contentStyle as Record<string, unknown> | null;
  if (!prevStyle) return [];

  const drifts: StyleDrift[] = [];
  const current = currentFeatures[0];

  // 对比语气变化
  const prevTone = (prevStyle.tone as string) || "";
  if (prevTone && current.tone && prevTone !== current.tone) {
    drifts.push({
      dimension: "语气调性",
      before: prevTone,
      after: current.tone,
      severity: "medium",
    });
  }

  // 对比结构变化
  const prevStructure = (prevStyle.structure as string[]) || [];
  if (prevStructure.length > 0 && current.structure) {
    const prevStr = prevStructure.join("→");
    if (!current.structure.includes(prevStr.slice(0, 6))) {
      drifts.push({
        dimension: "内容结构",
        before: prevStr,
        after: current.structure,
        severity: "low",
      });
    }
  }

  if (drifts.length > 0) {
    logger.warn({ tenantId, drifts }, "⚠️ 检测到风格漂移");
  }

  return drifts;
}
