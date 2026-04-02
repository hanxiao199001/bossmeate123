import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "./base-tool.js";
import {
  semanticSearch,
  createEntry,
  getStats,
} from "../knowledge/knowledge-service.js";
import { retrieveForArticle } from "../knowledge/rag-retriever.js";

// ===== Tool 1: 知识库搜索 =====
export const knowledgeSearchTool: ITool = {
  name: "knowledge_search",
  description: "在租户知识库中进行语义搜索，返回与查询最相关的知识条目。",
  parameters: z.object({
    query: z.string().describe("搜索查询文本"),
    category: z.string().optional().describe("限定搜索的子库类别"),
    limit: z.number().optional().default(5).describe("返回结果数量，默认5"),
  }),

  async execute(params, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    try {
      const results = await semanticSearch({
        tenantId: context.tenantId,
        query: params.query as string,
        category: params.category as any,
        limit: (params.limit as number) || 5,
      });
      return { success: true, data: results, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, error: err.message, durationMs: Date.now() - start };
    }
  },
};

// ===== Tool 2: RAG 上下文检索 =====
export const ragRetrieveTool: ITool = {
  name: "rag_retrieve",
  description: "为内容生成做 RAG 检索，从多个子库并行检索，返回整合后的上下文文本。",
  parameters: z.object({
    topic: z.string().describe("内容主题"),
    audience: z.string().optional().describe("目标受众"),
    tone: z.string().optional().describe("写作风格/语调"),
    keywords: z.array(z.string()).optional().describe("关键词列表"),
  }),

  async execute(params, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    try {
      const result = await retrieveForArticle({
        tenantId: context.tenantId,
        topic: params.topic as string,
        audience: params.audience as string | undefined,
        tone: params.tone as string | undefined,
        keywords: params.keywords as string[] | undefined,
      });
      return {
        success: true,
        data: { text: result.text, sources: result.sources, totalHits: result.totalHits },
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { success: false, error: err.message, durationMs: Date.now() - start };
    }
  },
};

// ===== Tool 3: 知识库统计 =====
export const knowledgeStatsTool: ITool = {
  name: "knowledge_stats",
  description: "获取租户知识库各子库的条目数量统计。",
  parameters: z.object({}),

  async execute(_params, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    try {
      const stats = await getStats(context.tenantId);
      return { success: true, data: stats, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, error: err.message, durationMs: Date.now() - start };
    }
  },
};

// ===== Tool 4: 创建知识条目 =====
export const knowledgeCreateTool: ITool = {
  name: "knowledge_create",
  description: "向知识库添加新条目，自动生成向量嵌入。",
  parameters: z.object({
    category: z.string().describe("子库类别: term / redline / audience / style / insight 等"),
    title: z.string().describe("条目标题"),
    content: z.string().describe("条目内容"),
    source: z.string().optional().describe("来源说明"),
  }),

  async execute(params, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    try {
      const entry = await createEntry({
        tenantId: context.tenantId,
        category: params.category as any,
        title: params.title as string,
        content: params.content as string,
        source: params.source as string | undefined,
      });
      return { success: true, data: entry, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, error: err.message, durationMs: Date.now() - start };
    }
  },
};

// ===== 所有内置工具列表 =====
export const builtinTools: ITool[] = [
  knowledgeSearchTool,
  ragRetrieveTool,
  knowledgeStatsTool,
  knowledgeCreateTool,
];
