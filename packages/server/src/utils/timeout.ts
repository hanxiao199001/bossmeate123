/**
 * 请求超时工具函数
 *
 * 提供可配置的 AbortController 超时控制，用于限制 AI API 请求的响应时间
 */

import { logger } from "../config/logger.js";

export interface TimeoutOptions {
  /** 超时时间（毫秒） */
  timeoutMs: number;
  /** 超时时触发的回调 */
  onTimeout?: () => void;
  /** 操作描述（用于日志） */
  description?: string;
}

/**
 * 为 fetch 请求创建带超时的 AbortController
 *
 * @param options 超时选项
 * @returns AbortController 实例和清理函数
 *
 * @example
 * ```ts
 * const { controller, cleanup } = createTimeoutController({
 *   timeoutMs: 60000,
 *   description: 'AI chat request'
 * });
 *
 * try {
 *   const response = await fetch(url, {
 *     signal: controller.signal,
 *     method: 'POST',
 *     body: JSON.stringify(payload)
 *   });
 * } finally {
 *   cleanup();
 * }
 * ```
 */
export function createTimeoutController(options: TimeoutOptions): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const { timeoutMs, onTimeout, description } = options;

  let timeoutId: NodeJS.Timeout | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  timeoutId = setTimeout(() => {
    if (isCleanedUp) return;

    logger.warn(
      {
        timeoutMs,
        description,
      },
      "请求超时，中止操作"
    );

    if (onTimeout) {
      try {
        onTimeout();
      } catch (error) {
        logger.error({ error }, "超时回调执行失败");
      }
    }

    controller.abort();
    timeoutId = null;
  }, timeoutMs);

  return { controller, cleanup };
}

/**
 * 为异步操作添加超时限制
 *
 * @param promise 要执行的 Promise
 * @param timeoutMs 超时时间（毫秒）
 * @param description 操作描述（用于日志）
 * @returns 返回原始 Promise 或超时错误
 *
 * @example
 * ```ts
 * const result = await withTimeout(
 *   fetch(url).then(r => r.json()),
 *   60000,
 *   'AI API request'
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description?: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        logger.warn(
          {
            timeoutMs,
            description,
          },
          "异步操作超时"
        );
        reject(
          new Error(
            `操作超时（${timeoutMs}ms）${description ? `: ${description}` : ""}`
          )
        );
      }, timeoutMs);
    }),
  ]);
}
