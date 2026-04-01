/**
 * Embedding 服务
 * 封装 DeepSeek Embedding API，支持单条和批量调用
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

const DEEPSEEK_EMBEDDING_URL = "https://api.deepseek.com/v1/embeddings";
const EMBEDDING_MODEL = "deepseek-embedding";
const EMBEDDING_DIMENSION = 1024;

/** 单次批量上限（DeepSeek 限制） */
const MAX_BATCH_SIZE = 16;

export interface EmbeddingResult {
  vector: number[];
  tokensUsed: number;
}

/**
 * 获取单条文本的 embedding
 */
export async function getEmbedding(text: string): Promise<EmbeddingResult> {
  const results = await getEmbeddings([text]);
  return results[0];
}

/**
 * 批量获取 embedding（自动分批）
 */
export async function getEmbeddings(
  texts: string[]
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置，无法生成 embedding");
  }

  const allResults: EmbeddingResult[] = [];

  // 按 MAX_BATCH_SIZE 分批
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchResults = await callEmbeddingAPI(apiKey, batch);
    allResults.push(...batchResults);
  }

  return allResults;
}

/**
 * 调用 DeepSeek Embedding API
 */
async function callEmbeddingAPI(
  apiKey: string,
  inputs: string[]
): Promise<EmbeddingResult[]> {
  logger.debug(
    { count: inputs.length, model: EMBEDDING_MODEL },
    "Embedding 调用开始"
  );

  const response = await fetch(DEEPSEEK_EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error(
      { status: response.status, error },
      "Embedding API 错误"
    );
    throw new Error(`DeepSeek Embedding 错误: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage: { prompt_tokens: number; total_tokens: number };
  };

  const tokensPerItem = Math.ceil(
    data.usage.prompt_tokens / inputs.length
  );

  // 按 index 排序确保顺序一致
  const sorted = data.data.sort((a, b) => a.index - b.index);

  logger.info(
    {
      count: inputs.length,
      totalTokens: data.usage.total_tokens,
    },
    "Embedding 调用成功"
  );

  return sorted.map((item) => ({
    vector: item.embedding,
    tokensUsed: tokensPerItem,
  }));
}

/**
 * 返回 embedding 维度（供外部校验）
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION;
}
