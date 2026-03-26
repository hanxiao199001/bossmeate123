/**
 * AI Provider 工厂
 * 根据环境变量配置创建对应的提供商实例
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { AIProvider } from "./providers/base.js";
import { AnthropicProvider } from "./providers/anthropic.js";
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

  // ====== 贵模型 ======

  if (env.ANTHROPIC_API_KEY) {
    expensive.push(
      new AnthropicProvider(env.ANTHROPIC_API_KEY)
    );
    logger.info("✅ Anthropic Claude 已加载");
  }

  if (env.OPENAI_API_KEY) {
    expensive.push(
      new OpenAICompatibleProvider(
        "openai",
        env.OPENAI_API_KEY,
        "https://api.openai.com/v1",
        "gpt-4o"
      )
    );
    logger.info("✅ OpenAI GPT 已加载");
  }

  // ====== 便宜模型 ======

  if (env.DEEPSEEK_API_KEY) {
    cheap.push(
      new OpenAICompatibleProvider(
        "deepseek",
        env.DEEPSEEK_API_KEY,
        "https://api.deepseek.com/v1",
        "deepseek-chat"
      )
    );
    logger.info("✅ DeepSeek 已加载");
  }

  if (env.QWEN_API_KEY) {
    cheap.push(
      new OpenAICompatibleProvider(
        "qwen",
        env.QWEN_API_KEY,
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "qwen-plus"
      )
    );
    logger.info("✅ 通义千问 已加载");
  }

  // 如果贵模型没有配置，把便宜模型也加进去（降级）
  if (expensive.length === 0 && cheap.length > 0) {
    logger.warn("⚠️ 未配置贵模型，所有任务将使用便宜模型");
    expensive.push(...cheap);
  }

  // 如果便宜模型没有配置，把贵模型也加进去
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
