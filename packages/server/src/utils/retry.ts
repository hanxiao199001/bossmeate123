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

/** 带结构化状态码的错误 —— provider 层抛错时挂上, 免得下游靠解析文案猜 */
export interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
}

/**
 * 8-02: 超时/中断**一律不重试**。
 * 推理型模型超时是它自身属性(想久了), 立刻重试大概率再超时, 纯烧调用配额 ——
 * 而调用配额有日硬上限(LLM_DAILY_CALL_CAP), 烧光了整条生成链路停摆。
 * 注意这条判断必须排在状态码判断**之前**: abort 类错误可能同时带 5xx 文案。
 */
export function isAbortLike(error: Error): boolean {
  const name = error.name ?? "";
  const msg = error.message ?? "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /this operation was aborted|the operation was aborted|aborted|abort/i.test(msg) ||
    /timed?\s*out|timeout|ETIMEDOUT/i.test(msg)
  );
}

/** 从错误里取 HTTP 状态码: 先读结构化字段, 再退回解析文案 */
export function extractStatus(error: Error): number | null {
  const e = error as HttpishError;
  // ① 结构化(provider 层已挂, 见 openai-compatible.ts) —— 唯一可靠的来源
  const structured = e.status ?? e.statusCode;
  if (typeof structured === "number" && structured >= 100 && structured < 600) return structured;

  // ② 文案兜底。**只为兼容还没挂 status 的老抛错点**, 不是主路径。
  //   8-02 教训: 原实现只认 /API (\d{3}):/ 这一种写法(带冒号), 而项目真实的抛错格式是
  //   `${name} API 错误: ${status} - ${body}`(openai-compatible.ts:121) —— 中间是中文"错误:",
  //   数字在冒号**后面**。两者永远匹配不上 → statusCode 恒 null → **对任何错误都不重试**,
  //   包括真该重试的 429 限流和 5xx。这个 withRetry 当了很久的摆设。
  const m =
    error.message.match(/API\s*错误[:：]\s*(\d{3})/) ??   // 本项目 provider 的真实格式
    error.message.match(/API\s*(\d{3})\s*[:：]/) ??        // 老格式(带冒号)
    error.message.match(/\bstatus\s*[:=]?\s*(\d{3})\b/i) ??
    error.message.match(/\b(429|5\d{2})\b/);               // 最后兜底: 裸状态码
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * 判断是否应该重试该错误。
 *
 * 重试: 429(限流) / 5xx(服务端) / 连接层瞬断(ECONNRESET、socket hang up、EAI_AGAIN…)
 * 不重试: 超时/中断(见 isAbortLike) / 其余 4xx(参数错、鉴权错, 重试多少次都一样)
 */
export function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  if (!(error instanceof Error)) return false;

  // ① 超时/中断 —— 最优先, 永不重试
  if (isAbortLike(error)) return false;

  // ② 状态码
  const status = extractStatus(error);
  if (status !== null) {
    return status === 429 || (status >= 500 && status < 600);
  }

  // ③ 连接层瞬断: 这类是"根本没到达服务端", 重试很可能就好了
  const code = (error as HttpishError).code ?? "";
  const msg = error.message ?? "";
  if (
    /^(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND)$/.test(code) ||
    /socket hang up|ECONNRESET|EPIPE|EAI_AGAIN|network error|fetch failed/i.test(msg)
  ) {
    return true;
  }

  // ④ 认不出来的错误不重试 —— 保守: 宁可少重试, 也不要在未知错误上烧配额
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
