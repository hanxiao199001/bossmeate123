/**
 * RAG 检索器
 * 根据写作场景从知识库组装上下文，注入 AI prompt
 */

import { logger } from "../../config/logger.js";
import { semanticSearch, hybridSearch } from "./knowledge-service.js";
import type { VectorCategory } from "./vector-store.js";

// ============ 检索结果格式 ============

export interface RAGContext {
  /** 拼接好的文本，直接注入 prompt */
  text: string;
  /** 命中的子库和条数 */
  sources: Array<{ category: string; count: number }>;
  /** 总命中条数 */
  totalHits: number;
}

const EMPTY_CONTEXT: RAGContext = { text: "", sources: [], totalHits: 0 };

// ============ 场景检索策略 ============

/**
 * 图文线 RAG — 根据需求主题检索多个子库
 * 用于 ArticleSkill.fullGenerate()
 */
export async function retrieveForArticle(params: {
  tenantId: string;
  topic: string;
  audience?: string;
  tone?: string;
  keywords?: string[];
}): Promise<RAGContext> {
  const { tenantId, topic, audience, tone, keywords } = params;

  // 并行检索多个子库
  const [terms, redlines, audiences, styles, insights, domainKnowledge] = await Promise.all([
    // 术语库：用主题检索专业术语定义
    safeSearch(tenantId, topic, "term", 3),
    // 红线库：检索相关禁忌规则
    safeSearch(tenantId, topic, "redline", 3),
    // 人群画像：用受众描述检索
    audience ? safeSearch(tenantId, audience, "audience", 2) : [],
    // IP风格：用调性检索
    tone ? safeSearch(tenantId, tone, "style", 2) : [],
    // 洞察策略：用主题检索
    safeSearch(tenantId, topic, "insight", 3),
    // 领域知识：用主题检索
    safeSearch(tenantId, topic, "domain_knowledge", 3),
  ]);

  // 如果有关键词，额外检索关键词库
  let keywordHits: SearchHit[] = [];
  if (keywords && keywords.length > 0) {
    keywordHits = await safeSearch(tenantId, keywords.join(" "), "keyword", 5);
  }

  // 组装上下文文本
  const sections: string[] = [];
  const sources: RAGContext["sources"] = [];

  if (terms.length > 0) {
    sections.push("【术语定义】\n" + terms.map((t) => `- ${t.title}: ${t.content}`).join("\n"));
    sources.push({ category: "term", count: terms.length });
  }

  if (redlines.length > 0) {
    sections.push("【内容红线 — 必须规避】\n" + redlines.map((t) => `- ${t.title}: ${t.content}`).join("\n"));
    sources.push({ category: "redline", count: redlines.length });
  }

  if (audiences.length > 0) {
    sections.push("【目标受众画像】\n" + audiences.map((t) => t.content).join("\n"));
    sources.push({ category: "audience", count: audiences.length });
  }

  if (styles.length > 0) {
    sections.push("【风格要求】\n" + styles.map((t) => t.content).join("\n"));
    sources.push({ category: "style", count: styles.length });
  }

  if (insights.length > 0) {
    sections.push("【策略参考】\n" + insights.map((t) => `- ${t.title}: ${t.content}`).join("\n"));
    sources.push({ category: "insight", count: insights.length });
  }

  if (domainKnowledge.length > 0) {
    sections.push("【领域知识】\n" + domainKnowledge.map((t) => `- ${t.title}: ${t.content}`).join("\n"));
    sources.push({ category: "domain_knowledge", count: domainKnowledge.length });
  }

  if (keywordHits.length > 0) {
    sections.push("【相关关键词】\n" + keywordHits.map((t) => t.title).join("、"));
    sources.push({ category: "keyword", count: keywordHits.length });
  }

  const totalHits = sources.reduce((s, v) => s + v.count, 0);

  if (sections.length === 0) {
    logger.debug({ tenantId, topic }, "RAG: 未命中任何知识条目");
    return EMPTY_CONTEXT;
  }

  const text = sections.join("\n\n");
  logger.info({ tenantId, topic, totalHits, sources }, "RAG: 检索完成");

  return { text, sources, totalHits };
}

/**
 * 工作流 RAG — 根据标题+关键词+学科检索
 * 用于 workflow/generate-article
 */
export async function retrieveForWorkflow(params: {
  tenantId: string;
  title: string;
  keywords: string[];
  discipline?: string;
}): Promise<RAGContext> {
  const { tenantId, title, keywords, discipline } = params;
  const query = [title, ...keywords, discipline].filter(Boolean).join(" ");

  const [terms, redlines, platformRules, domainKnowledge] = await Promise.all([
    safeSearch(tenantId, query, "term", 5),
    safeSearch(tenantId, query, "redline", 3),
    safeSearch(tenantId, query, "platform_rule", 3),
    safeSearch(tenantId, query, "domain_knowledge", 5),
  ]);

  const sections: string[] = [];
  const sources: RAGContext["sources"] = [];

  if (terms.length > 0) {
    sections.push("【术语定义 — 文中涉及这些术语时请使用准确定义】\n" + terms.map((t) => `- ${t.title}: ${t.content}`).join("\n"));
    sources.push({ category: "term", count: terms.length });
  }

  if (redlines.length > 0) {
    sections.push("【内容红线 — 以下内容绝对不能出现】\n" + redlines.map((t) => `- ${t.content}`).join("\n"));
    sources.push({ category: "redline", count: redlines.length });
  }

  if (platformRules.length > 0) {
    sections.push("【平台规则提醒】\n" + platformRules.map((t) => `- ${t.content}`).join("\n"));
    sources.push({ category: "platform_rule", count: platformRules.length });
  }

  if (domainKnowledge.length > 0) {
    sections.push("【领域知识参考】\n" + domainKnowledge.map((t) => `- ${t.title}: ${t.content}`).join("\n"));
    sources.push({ category: "domain_knowledge", count: domainKnowledge.length });
  }

  const totalHits = sources.reduce((s, v) => s + v.count, 0);

  if (sections.length === 0) return EMPTY_CONTEXT;

  const text = sections.join("\n\n");
  logger.info({ tenantId, title, totalHits }, "RAG(workflow): 检索完成");

  return { text, sources, totalHits };
}

// ============ 内部工具 ============

interface SearchHit {
  id: string;
  title: string;
  content: string;
  category: string;
  score: number;
}

async function safeSearch(
  tenantId: string,
  query: string,
  category: VectorCategory,
  limit: number
): Promise<SearchHit[]> {
  try {
    const results = await semanticSearch({ tenantId, query, category, limit, minScore: 0.15 });
    return results;
  } catch (err) {
    logger.debug({ category, error: (err as Error).message }, "RAG: 子库检索失败，跳过");
    return [];
  }
}
