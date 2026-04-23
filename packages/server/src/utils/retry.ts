/**
 * 重试工具函数
 *
 * 提供带有指数退避的重试机制，用于处理临时性错误（速率限制、服务器错误等）
 */

import { logger } from "../config/logger.js";

export interface RetryOptions {
  /** 最大重试次数（默认3次） */
  maxRetries?: number;
  /** 初始延迟时间（毫秒，默认1000） */
  initialDelayMs?: number;
  /** 是否只在特定错误类型上重试 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * 判断是否应该重试该错误
 * - 只重试 429 (Rate Limit) 和 5xx 错误
 * - 不重试 4xx 错误（除了 429）
 */
function defaultShouldRetry(error: unknown, attempt: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // 解析错误信息中的 HTTP 状态码
  const statusMatch = error.message.match(/API (\d{3}):|Anthropic API (\d{3}):/);
  const statusCode = statusMatch ? parseInt(statusMatch[1] || statusMatch[2]) : null;

  if (statusCode === null) {
    return false;
  }

  // 只重试 429 (Rate Limit) 和 5xx 错误
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
    return true;
  }

  return false;
}

/**
 * 执行函数，如果失败则按指数退避策略重试
 *
 * @param fn 要执行的异步函数
 * @param options 重试选项
 * @returns 执行结果
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   async () => {
 *     return await fetch(url).then(r => r.json());
 *   },
 *   {
 *     maxRetries: 3,
 *     initialDelayMs: 1000,
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 如果不应该重试，直接抛出
      if (!shouldRetry(error, attempt)) {
        throw error;
      }

      // 如果已达最大重试次数，抛出
      if (attempt === maxRetries) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            attempts: attempt + 1,
          },
          "重试失败，已达最大重试次数"
        );
        throw error;
      }

      // 计算延迟时间（指数退避）
      // 延迟序列：1s, 2s, 4s, ...
      const delayMs = initialDelayMs * Math.pow(2, attempt);
      logger.debug(
        {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
          nextRetryIn: delayMs,
        },
        "API 调用失败，准备重试"
      );

      // 等待后重试
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // 不应该到达这里，但以防万一
  throw lastError;
}
