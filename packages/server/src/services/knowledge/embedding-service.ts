/**
 * Embedding 服务
 * 优先级：DashScope text-embedding-v3 → DeepSeek → 本地 hash（开发 fallback）
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/** 各模型的原生向量维度 */
const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-v3": 1024,      // DashScope 通义千问
  "deepseek-embedding": 1024,      // DeepSeek
  "text-embedding-3-small": 1536,  // OpenAI
  "text-embedding-3-large": 3072,  // OpenAI
};

/** 统一维度（取当前后端的原生维度，无匹配时默认 1024） */
let EMBEDDING_DIMENSION = 1024;

/** 单次批量上限 */
const MAX_BATCH_SIZE = 16;

// 支持的 embedding 后端
interface EmbeddingBackend {
  name: string;
  url: string;
  model: string;
  apiKey: string;
  dimension: number;
}

export interface EmbeddingResult {
  vector: number[];
  tokensUsed: number;
}

function getBackend(): EmbeddingBackend | null {
  // 优先 DashScope（通义千问）
  if (env.QWEN_API_KEY && env.QWEN_API_KEY !== "your-qwen-api-key") {
    const model = "text-embedding-v3";
    return {
      name: "dashscope",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
      model,
      apiKey: env.QWEN_API_KEY,
      dimension: MODEL_DIMENSIONS[model] || 1024,
    };
  }
  // 其次 DeepSeek
  if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY !== "your-deepseek-api-key") {
    const model = "deepseek-embedding";
    return {
      name: "deepseek",
      url: "https://api.deepseek.com/v1/embeddings",
      model,
      apiKey: env.DEEPSEEK_API_KEY,
      dimension: MODEL_DIMENSIONS[model] || 1024,
    };
  }
  return null;
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

  const backend = getBackend();

  // 动态更新维度以匹配当前后端
  if (backend) {
    EMBEDDING_DIMENSION = backend.dimension;
  }

  if (!backend) {
    // 开发环境 fallback：用确定性 hash 生成伪向量
    if (env.NODE_ENV === "development") {
      logger.warn("无可用 Embedding API，使用本地 hash 向量（仅开发环境）");
      return texts.map((t) => ({
        vector: hashToVector(t),
        tokensUsed: Math.ceil(t.length / 4),
      }));
    }
    throw new Error("无可用 Embedding API Key，请配置 QWEN_API_KEY / DEEPSEEK_API_KEY");
  }

  const allResults: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    try {
      const batchResults = await callEmbeddingAPI(backend, batch);
      allResults.push(...batchResults);
    } catch (err) {
      // API 失败时开发环境 fallback
      if (env.NODE_ENV === "development") {
        logger.warn(
          { backend: backend.name, error: (err as Error).message },
          "Embedding API 失败，fallback 到本地 hash"
        );
        allResults.push(
          ...batch.map((t) => ({
            vector: hashToVector(t),
            tokensUsed: Math.ceil(t.length / 4),
          }))
        );
      } else {
        throw err;
      }
    }
  }

  return allResults;
}

/**
 * 调用 OpenAI 兼容的 Embedding API
 */
async function callEmbeddingAPI(
  backend: EmbeddingBackend,
  inputs: string[]
): Promise<EmbeddingResult[]> {
  logger.debug(
    { count: inputs.length, backend: backend.name, model: backend.model },
    "Embedding 调用开始"
  );

  const bodyPayload: Record<string, unknown> = {
    model: backend.model,
    input: inputs,
    encoding_format: "float",
  };

  // DashScope text-embedding-v3 支持指定维度
  if (backend.name === "dashscope") {
    bodyPayload.dimensions = EMBEDDING_DIMENSION;
  }

  const response = await fetch(backend.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backend.apiKey}`,
    },
    body: JSON.stringify(bodyPayload),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error(
      { backend: backend.name, status: response.status, error },
      "Embedding API 错误"
    );
    throw new Error(`${backend.name} Embedding 错误: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage: { prompt_tokens: number; total_tokens: number };
  };

  const tokensPerItem = Math.ceil(
    data.usage.prompt_tokens / inputs.length
  );

  const sorted = data.data.sort((a, b) => a.index - b.index);

  logger.info(
    { backend: backend.name, count: inputs.length, totalTokens: data.usage.total_tokens },
    "Embedding 调用成功"
  );

  return sorted.map((item) => ({
    vector: padOrTruncate(item.embedding, EMBEDDING_DIMENSION),
    tokensUsed: tokensPerItem,
  }));
}

/**
 * 确保向量维度一致（不同模型可能返回不同维度）
 */
function padOrTruncate(vec: number[], dim: number): number[] {
  if (vec.length === dim) return vec;
  if (vec.length > dim) return vec.slice(0, dim);
  return [...vec, ...new Array(dim - vec.length).fill(0)];
}

/**
 * 确定性 hash → 伪向量（开发 fallback，非语义）
 */
function hashToVector(text: string): number[] {
  const vector = new Array(EMBEDDING_DIMENSION).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const idx = (code * 31 + i * 17) % EMBEDDING_DIMENSION;
    vector[idx] = (vector[idx] + Math.sin(code * (i + 1))) * 0.5;
  }
  // 归一化
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/**
 * 返回 embedding 维度
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION;
}
