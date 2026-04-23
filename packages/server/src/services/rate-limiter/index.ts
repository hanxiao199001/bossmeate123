/**
 * 外部 API 调用限流器
 *
 * 基于 Redis 的令牌桶算法，按 provider 独立限流
 * 防止 OpenAI/TTS/平台API 因并发过高触发 429
 *
 * 用法:
 *   const result = await rateLimiter.acquire("openai");
 *   if (!result.allowed) await sleep(result.retryAfterMs);
 *
 * 装饰器用法:
 *   const limitedFn = withRateLimit("openai", originalFn);
 */

import { getRedisConnection } from "../task/queue.js";
import { logger } from "../../config/logger.js";

/** 限流配置 */
export interface RateLimitConfig {
  /** 每分钟最大请求数 */
  maxPerMinute: number;
  /** 排队等待超时（毫秒），默认 30000 */
  waitTimeoutMs?: number;
}

/** 各 provider 的默认限流配置 */
const DEFAULT_CONFIGS: Record<string, RateLimitConfig> = {
  openai:      { maxPerMinute: 60, waitTimeoutMs: 30_000 },
  anthropic:   { maxPerMinute: 60, waitTimeoutMs: 30_000 },
  deepseek:    { maxPerMinute: 60, waitTimeoutMs: 30_000 },
  "aliyun-tts": { maxPerMinute: 20, waitTimeoutMs: 15_000 },
  pexels:      { maxPerMinute: 200, waitTimeoutMs: 10_000 },  // 200/小时 ≈ 3.3/分钟，但按分钟窗口放宽
  baijiahao:   { maxPerMinute: 10, waitTimeoutMs: 30_000 },
  toutiao:     { maxPerMinute: 10, waitTimeoutMs: 30_000 },
  zhihu:       { maxPerMinute: 10, waitTimeoutMs: 30_000 },
  xiaohongshu: { maxPerMinute: 10, waitTimeoutMs: 30_000 },
  "wechat-work": { maxPerMinute: 20, waitTimeoutMs: 15_000 },
};

/** acquire 返回值 */
interface AcquireResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

class RateLimiter {
  private configs: Map<string, RateLimitConfig> = new Map(
    Object.entries(DEFAULT_CONFIGS)
  );

  private get redis() {
    return getRedisConnection();
  }

  /**
   * 注册或覆盖 provider 限流配置
   */
  setConfig(provider: string, config: RateLimitConfig): void {
    this.configs.set(provider, config);
  }

  /**
   * 尝试获取一个令牌
   * 使用滑动窗口计数器（Redis INCR + EXPIRE）
   */
  async acquire(provider: string): Promise<AcquireResult> {
    const config = this.configs.get(provider);
    if (!config) {
      // 未配置的 provider 直接放行
      return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    }

    const windowKey = `bm:ratelimit:${provider}`;
    const now = Math.floor(Date.now() / 1000); // 当前秒
    const windowStart = Math.floor(now / 60) * 60; // 当前分钟的起始秒
    const key = `${windowKey}:${windowStart}`;

    const current = await this.redis.incr(key);

    // 首次写入时设置过期（2分钟，确保窗口过后自动清理）
    if (current === 1) {
      await this.redis.expire(key, 120);
    }

    if (current <= config.maxPerMinute) {
      return {
        allowed: true,
        remaining: config.maxPerMinute - current,
        retryAfterMs: 0,
      };
    }

    // 超限：计算下一个窗口的等待时间
    const nextWindowStart = windowStart + 60;
    const retryAfterMs = (nextWindowStart - now) * 1000;

    // 撤回这次 INCR（避免计数器虚高）
    await this.redis.decr(key);

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    };
  }

  /**
   * 带自动等待的获取令牌
   * 如果超限，自动等待直到可以执行或超时
   */
  async acquireOrWait(provider: string): Promise<void> {
    const config = this.configs.get(provider);
    const waitTimeout = config?.waitTimeoutMs ?? 30_000;
    const deadline = Date.now() + waitTimeout;

    while (Date.now() < deadline) {
      const result = await this.acquire(provider);
      if (result.allowed) return;

      const waitMs = Math.min(result.retryAfterMs, deadline - Date.now());
      if (waitMs <= 0) break;

      logger.debug(
        { provider, waitMs, remaining: result.remaining },
        "RateLimiter: 等待令牌"
      );

      await new Promise((r) => setTimeout(r, waitMs));
    }

    throw new Error(
      `RateLimiter: ${provider} 超限且等待超时(${waitTimeout}ms)`
    );
  }
}

export const rateLimiter = new RateLimiter();

/**
 * 包装函数，自动加限流
 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  provider: string,
  fn: T
): T {
  return (async (...args: any[]) => {
    await rateLimiter.acquireOrWait(provider);
    return fn(...args);
  }) as unknown as T;
}
