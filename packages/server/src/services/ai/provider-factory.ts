/**
 * AI Provider 工厂（T2 调整）
 *
 * 按手册约定：
 *   expensive = DeepSeek（默认 deepseek-chat，对应 content_generation 的 primary）
 *   cheap     = Qwen（默认 qwen-plus，对应 daily_chat 的 primary）
 *
 * Anthropic / OpenAI 分支已下线；`ANTHROPIC_API_KEY` 配置会在启动时打 warn（由 index.ts 负责）。
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { AIProvider } from "./providers/base.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

interface ProviderRegistry {
  expensive: AIProvider[];
  cheap: AIProvider[];
}

let registry: ProviderRegistry | null = null;

/**
 * 初始化并获取所有可用的 AI 提供商
 */
export function getProviders(): ProviderRegistry {
  if (registry) return registry;

  const expensive: AIProvider[] = [];
  const cheap: AIProvider[] = [];

  // expensive = DeepSeek
  if (env.DEEPSEEK_API_KEY) {
    expensive.push(
      new OpenAICompatibleProvider(
        "deepseek",
        env.DEEPSEEK_API_KEY,
        "https://api.deepseek.com/v1",
        env.DEEPSEEK_MODEL_CHAT
      )
    );
    logger.info({ model: env.DEEPSEEK_MODEL_CHAT }, "✅ DeepSeek 已加载");
  }

  // cheap = Qwen
  if (env.QWEN_API_KEY) {
    cheap.push(
      new OpenAICompatibleProvider(
        "qwen",
        env.QWEN_API_KEY,
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        env.QWEN_MODEL_PLUS
      )
    );
    logger.info({ model: env.QWEN_MODEL_PLUS }, "✅ 通义千问 已加载");
  }

  // 任一层级空时降级（保留原有兜底语义）
  if (expensive.length === 0 && cheap.length > 0) {
    logger.warn("⚠️ 未配置贵模型，所有任务将使用便宜模型");
    expensive.push(...cheap);
  }

  if (cheap.length === 0 && expensive.length > 0) {
    logger.warn("⚠️ 未配置便宜模型，所有任务将使用贵模型");
    cheap.push(...expensive);
  }

  if (expensive.length === 0 && cheap.length === 0) {
    logger.error("❌ 没有配置任何AI模型，请检查环境变量");
  }

  registry = { expensive, cheap };
  return registry;
}

/**
 * 获取指定层级的第一个可用提供商
 *
 * 兼容别名 —— 全项目 14 处调用，签名不变：
 *   getProvider("expensive") → DeepSeek (content_generation primary)
 *   getProvider("cheap")     → Qwen (daily_chat primary)
 */
export function getProvider(tier: "expensive" | "cheap"): AIProvider | null {
  const providers = getProviders();
  const list = tier === "expensive" ? providers.expensive : providers.cheap;
  return list[0] || null;
}

/**
 * 按名称获取提供商
 */
export function getProviderByName(name: string): AIProvider | null {
  const providers = getProviders();
  const all = [...providers.expensive, ...providers.cheap];
  return all.find((p) => p.name === name) || null;
}
