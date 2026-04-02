/**
 * T309: 数据素材结构化处理
 *
 * 从原始内容中提取结构化数据素材：
 * - 数据点提取（数字+单位+上下文）
 * - 图表描述提取
 * - 公式/模型提取
 * - 引用数据提取（来源+数据+年份）
 * - 结构化后向量化入库
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { ingestToKnowledge } from "./ingest-pipeline.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型定义 ============

export interface DataPoint {
  value: string;           // "95.3%", "1200万", "3.5倍"
  context: string;         // 上下文描述
  source?: string;         // 数据来源
  year?: string;           // 数据年份
  category: string;        // 市场规模/增长率/占比/排名/...
}

export interface StructuredData {
  dataPoints: DataPoint[];
  charts: Array<{ description: string; dataType: string }>;
  formulas: Array<{ name: string; expression: string; usage: string }>;
  citations: Array<{ source: string; data: string; year?: string }>;
}

// ============ 核心逻辑 ============

/**
 * 从文本中提取结构化数据素材
 */
export async function extractStructuredData(
  content: string,
  tenantId: string,
  source?: string
): Promise<StructuredData> {
  if (content.length < 50) {
    return { dataPoints: [], charts: [], formulas: [], citations: [] };
  }

  const textPreview = content.slice(0, 3000);

  const prompt = `从以下文本中提取所有结构化数据素材。

文本:
${textPreview}

直接输出 JSON（不要其他文字）:
{
  "dataPoints": [
    {"value": "具体数值", "context": "数据的上下文含义", "source": "数据来源", "year": "年份", "category": "类型"}
  ],
  "charts": [
    {"description": "图表描述", "dataType": "柱状图/折线图/饼图/表格"}
  ],
  "formulas": [
    {"name": "公式名称", "expression": "公式表达式", "usage": "用途说明"}
  ],
  "citations": [
    {"source": "引用来源", "data": "引用的数据内容", "year": "年份"}
  ]
}

规则:
- 只提取明确的数据点（有具体数字的）
- category 可选: 市场规模/增长率/占比/排名/成本/效率/对比
- 如果没有某类数据，该数组留空
- 最多各提取 10 条`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "data-structurize",
      message: prompt,
      skillType: "formatting",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { dataPoints: [], charts: [], formulas: [], citations: [] };
    }

    return JSON.parse(jsonMatch[0]) as StructuredData;
  } catch (err) {
    logger.error({ err }, "数据素材提取失败");
    return { dataPoints: [], charts: [], formulas: [], citations: [] };
  }
}

/**
 * 批量处理竞品内容中的数据素材并入库
 */
export async function processAndIngestDataMaterials(
  articles: Array<{ title: string; content: string; source: string }>,
  tenantId: string
): Promise<{ processed: number; ingested: number }> {
  logger.info({ tenantId, articleCount: articles.length }, "📊 开始数据素材结构化处理");

  let totalIngested = 0;

  for (const article of articles.slice(0, 10)) {
    const structured = await extractStructuredData(article.content, tenantId, article.source);

    const items: Array<{
      title: string;
      content: string;
      category: VectorCategory;
      source: string;
      metadata?: Record<string, unknown>;
    }> = [];

    // 数据点 → domain_knowledge
    if (structured.dataPoints.length > 0) {
      items.push({
        title: `数据素材: ${article.title}`,
        content: [
          `数据素材集 - ${article.title}`,
          "",
          ...structured.dataPoints.map(
            (dp) => `- ${dp.value}: ${dp.context}${dp.source ? ` (来源: ${dp.source})` : ""}${dp.year ? ` [${dp.year}]` : ""}`
          ),
        ].join("\n"),
        category: "domain_knowledge" as VectorCategory,
        source: article.source,
        metadata: {
          type: "data_points",
          count: structured.dataPoints.length,
          categories: [...new Set(structured.dataPoints.map((d) => d.category))],
        },
      });
    }

    // 引用数据 → domain_knowledge
    if (structured.citations.length > 0) {
      items.push({
        title: `引用数据: ${article.title}`,
        content: [
          `引用数据集 - ${article.title}`,
          "",
          ...structured.citations.map(
            (c) => `- [${c.source}${c.year ? `, ${c.year}` : ""}] ${c.data}`
          ),
        ].join("\n"),
        category: "domain_knowledge" as VectorCategory,
        source: article.source,
        metadata: { type: "citations", count: structured.citations.length },
      });
    }

    if (items.length > 0) {
      const result = await ingestToKnowledge(items, tenantId);
      totalIngested += result.ingested;
    }
  }

  logger.info(
    { processed: Math.min(articles.length, 10), ingested: totalIngested },
    "📊 数据素材结构化完成"
  );

  return { processed: Math.min(articles.length, 10), ingested: totalIngested };
}
