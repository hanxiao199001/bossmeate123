/**
 * RAG 检索器 V2 — P4 升级版
 *
 * T401: 全部 10 子库并行检索
 * T402: Token 预算管理（按优先级裁剪）
 * T413: Redis 缓存高频检索
 */

import { logger } from "../../config/logger.js";
import { semanticSearch } from "./knowledge-service.js";
import { VECTOR_CATEGORIES, type VectorCategory } from "./vector-store.js";
import { getRedisConnection } from "../task/queue.js";

// ============ 类型定义 ============

export interface RAGContextV2 {
  text: string;
  sources: Array<{ category: string; count: number; tokensUsed: number }>;
  totalHits: number;
  totalTokens: number;
  cached: boolean;
}

interface SearchHit {
  id: string;
  title: string;
  content: string;
  category: string;
  score: number;
}

interface CategoryConfig {
  category: VectorCategory;
  label: string;
  priority: number;        // 1=最高, 数字越大越低
  limit: number;           // 最大检索条数
  tokenBudget: number;     // 该子库的 Token 预算
  formatPrefix: string;    // 注入 prompt 的标题
}

// ============ 子库优先级配置 ============

const CATEGORY_CONFIGS: CategoryConfig[] = [
  { category: "redline",          label: "红线规则",   priority: 1, limit: 5, tokenBudget: 500,  formatPrefix: "【内容红线 — 必须规避】" },
  { category: "term",             label: "术语定义",   priority: 2, limit: 5, tokenBudget: 600,  formatPrefix: "【术语定义】" },
  { category: "domain_knowledge", label: "领域知识",   priority: 3, limit: 5, tokenBudget: 800,  formatPrefix: "【领域知识参考】" },
  { category: "audience",         label: "受众画像",   priority: 4, limit: 3, tokenBudget: 400,  formatPrefix: "【目标受众画像】" },
  { category: "style",            label: "风格模板",   priority: 5, limit: 3, tokenBudget: 400,  formatPrefix: "【风格要求】" },
  { category: "platform_rule",    label: "平台规则",   priority: 6, limit: 3, tokenBudget: 400,  formatPrefix: "【平台规则】" },
  { category: "insight",          label: "策略洞察",   priority: 7, limit: 3, tokenBudget: 500,  formatPrefix: "【策略参考】" },
  { category: "content_format",   label: "内容拆解",   priority: 8, limit: 3, tokenBudget: 500,  formatPrefix: "【内容形式参考】" },
  { category: "hot_event",        label: "热点事件",   priority: 9, limit: 3, tokenBudget: 400,  formatPrefix: "【近期热点】" },
  { category: "keyword",          label: "关键词",     priority: 10, limit: 5, tokenBudget: 300,  formatPrefix: "【相关关键词】" },
];

// 默认总 Token 预算（约 4000 token ≈ 6000 中文字符）
const DEFAULT_TOKEN_BUDGET = 4800;

// 缓存 TTL（5 分钟）
const CACHE_TTL = 300;

// ============ 核心检索 ============

/**
 * 全子库并行 RAG 检索（V2）
 */
export async function retrieveContextV2(params: {
  tenantId: string;
  query: string;
  tokenBudget?: number;
  categories?: VectorCategory[];   // 可选：只检索指定子库
  enableCache?: boolean;
}): Promise<RAGContextV2> {
  const {
    tenantId,
    query,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    categories,
    enableCache = true,
  } = params;

  // 1. 尝试缓存
  if (enableCache) {
    const cached = await getFromCache(tenantId, query);
    if (cached) {
      logger.debug({ tenantId, query: query.slice(0, 30) }, "RAG V2: 缓存命中");
      return { ...cached, cached: true };
    }
  }

  // 2. 确定要检索的子库
  const configs = categories
    ? CATEGORY_CONFIGS.filter((c) => categories.includes(c.category))
    : CATEGORY_CONFIGS;

  // 3. 全部子库并行检索
  const searchResults = await Promise.all(
    configs.map(async (config) => {
      const hits = await safeSearch(tenantId, query, config.category, config.limit);
      return { config, hits };
    })
  );

  // 4. 按优先级排序，Token 预算裁剪
  const sortedResults = searchResults
    .filter((r) => r.hits.length > 0)
    .sort((a, b) => a.config.priority - b.config.priority);

  let remainingBudget = tokenBudget;
  const sections: string[] = [];
  const sources: RAGContextV2["sources"] = [];

  for (const { config, hits } of sortedResults) {
    if (remainingBudget <= 0) break;

    const categoryBudget = Math.min(config.tokenBudget, remainingBudget);
    const { text, tokensUsed } = formatHitsWithBudget(hits, config, categoryBudget);

    if (text) {
      sections.push(text);
      sources.push({ category: config.category, count: hits.length, tokensUsed });
      remainingBudget -= tokensUsed;
    }
  }

  const totalHits = sources.reduce((s, v) => s + v.count, 0);
  const totalTokens = tokenBudget - remainingBudget;
  const resultText = sections.join("\n\n");

  const result: RAGContextV2 = {
    text: resultText,
    sources,
    totalHits,
    totalTokens,
    cached: false,
  };

  // 5. 写入缓存
  if (enableCache && totalHits > 0) {
    await setCache(tenantId, query, result);
  }

  logger.info(
    { tenantId, query: query.slice(0, 30), totalHits, totalTokens, categories: sources.length },
    "RAG V2: 检索完成"
  );

  return result;
}

/**
 * 图文生成专用 RAG（兼容旧接口）
 */
export async function retrieveForArticleV2(params: {
  tenantId: string;
  topic: string;
  audience?: string;
  tone?: string;
  keywords?: string[];
  platform?: string;
  tokenBudget?: number;
}): Promise<RAGContextV2> {
  const { tenantId, topic, audience, tone, keywords, platform, tokenBudget } = params;

  // 组合查询词
  const queryParts = [topic];
  if (audience) queryParts.push(audience);
  if (tone) queryParts.push(tone);
  if (keywords?.length) queryParts.push(keywords.join(" "));
  const query = queryParts.join(" ");

  return retrieveContextV2({
    tenantId,
    query,
    tokenBudget,
  });
}

// ============ Token 预算裁剪 ============

function formatHitsWithBudget(
  hits: SearchHit[],
  config: CategoryConfig,
  budget: number
): { text: string; tokensUsed: number } {
  const lines: string[] = [];
  let tokensUsed = 0;

  // 预留标题的 token
  const headerTokens = estimateTokens(config.formatPrefix);
  tokensUsed += headerTokens;

  for (const hit of hits) {
    const line = config.category === "keyword"
      ? hit.title
      : `- ${hit.title}: ${hit.content}`;

    const lineTokens = estimateTokens(line);

    if (tokensUsed + lineTokens > budget) {
      // 尝试截断内容
      const remaining = budget - tokensUsed;
      if (remaining > 20) {
        const truncated = truncateToTokens(line, remaining);
        lines.push(truncated);
        tokensUsed += remaining;
      }
      break;
    }

    lines.push(line);
    tokensUsed += lineTokens;
  }

  if (lines.length === 0) {
    return { text: "", tokensUsed: 0 };
  }

  const text = config.category === "keyword"
    ? `${config.formatPrefix}\n${lines.join("、")}`
    : `${config.formatPrefix}\n${lines.join("\n")}`;

  return { text, tokensUsed };
}

/**
 * 估算中文 Token 数（1 token ≈ 1.5 中文字符）
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  // 粗略按字符数裁剪
  const maxChars = Math.floor(maxTokens * 1.5);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

// ============ Redis 缓存 ============

function cacheKey(tenantId: string, query: string): string {
  // 简单 hash：取 query 前 100 字符
  const q = query.slice(0, 100).replace(/\s+/g, "_");
  return `rag:v2:${tenantId}:${q}`;
}

async function getFromCache(tenantId: string, query: string): Promise<RAGContextV2 | null> {
  try {
    const redis = getRedisConnection();
    const cached = await redis.get(cacheKey(tenantId, query));
    if (!cached) return null;
    return JSON.parse(cached);
  } catch {
    return null;
  }
}

async function setCache(tenantId: string, query: string, result: RAGContextV2): Promise<void> {
  try {
    const redis = getRedisConnection();
    await redis.setex(cacheKey(tenantId, query), CACHE_TTL, JSON.stringify(result));
  } catch {
    // 缓存写入失败不影响主流程
  }
}

// ============ 安全搜索 ============

async function safeSearch(
  tenantId: string,
  query: string,
  category: VectorCategory,
  limit: number
): Promise<SearchHit[]> {
  try {
    return await semanticSearch({ tenantId, query, category, limit, minScore: 0.15 });
  } catch (err) {
    logger.debug({ category, error: (err as Error).message }, "RAG V2: 子库检索失败");
    return [];
  }
}
