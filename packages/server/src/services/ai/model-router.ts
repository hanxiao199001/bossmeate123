/**
 * AI 模型路由器
 *
 * 核心逻辑：根据任务类型和重要性，分配到不同模型
 * - 贵模型（Claude/GPT）：内容生成、复杂分析、质检、需求拆解
 * - 便宜模型（DeepSeek/千问）：日常问答、格式化、常规客服
 *
 * 包含熔断机制：贵模型连续失败N次后，自动切到备选模型
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

// 任务类型定义
export type TaskType =
  | "content_generation"   // 内容生成（图文、脚本）→ 贵模型
  | "requirement_analysis" // 需求理解和拆解 → 贵模型
  | "quality_check"        // 质检校准 → 贵模型
  | "knowledge_search"     // 知识库检索增强 → 贵模型
  | "daily_chat"           // 日常问答 → 便宜模型
  | "formatting"           // 格式化处理 → 便宜模型
  | "customer_service"     // 常规客服 → 便宜模型
  | "translation";         // 翻译 → 便宜模型

// 模型提供商配置
interface ModelProvider {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
}

// 熔断器状态
interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

// 任务到模型的映射
const TASK_MODEL_MAP: Record<TaskType, "expensive" | "cheap"> = {
  content_generation: "expensive",
  requirement_analysis: "expensive",
  quality_check: "expensive",
  knowledge_search: "expensive",
  daily_chat: "cheap",
  formatting: "cheap",
  customer_service: "cheap",
  translation: "cheap",
};

class ModelRouter {
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private threshold: number;

  constructor() {
    this.threshold = env.MODEL_CIRCUIT_BREAKER_THRESHOLD;
  }

  /**
   * 获取可用的模型提供商列表
   */
  getProviders(): { expensive: ModelProvider[]; cheap: ModelProvider[] } {
    const expensive: ModelProvider[] = [];
    const cheap: ModelProvider[] = [];

    // 贵模型
    if (env.ANTHROPIC_API_KEY) {
      expensive.push({
        name: "anthropic",
        model: env.DEFAULT_EXPENSIVE_MODEL,
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: "https://api.anthropic.com",
        maxTokens: 4096,
      });
    }
    if (env.OPENAI_API_KEY) {
      expensive.push({
        name: "openai",
        model: "gpt-4o",
        apiKey: env.OPENAI_API_KEY,
        baseUrl: "https://api.openai.com/v1",
        maxTokens: 4096,
      });
    }

    // 便宜模型
    if (env.DEEPSEEK_API_KEY) {
      cheap.push({
        name: "deepseek",
        model: env.DEFAULT_CHEAP_MODEL,
        apiKey: env.DEEPSEEK_API_KEY,
        baseUrl: "https://api.deepseek.com/v1",
        maxTokens: 4096,
      });
    }
    if (env.QWEN_API_KEY) {
      cheap.push({
        name: "qwen",
        model: "qwen-plus",
        apiKey: env.QWEN_API_KEY,
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        maxTokens: 4096,
      });
    }

    return { expensive, cheap };
  }

  /**
   * 根据任务类型选择模型
   */
  selectModel(taskType: TaskType): ModelProvider | null {
    const tier = TASK_MODEL_MAP[taskType];
    const providers = this.getProviders();
    const candidates = tier === "expensive" ? providers.expensive : providers.cheap;

    // 如果目标层级没有可用模型，降级到另一层
    if (candidates.length === 0) {
      const fallback = tier === "expensive" ? providers.cheap : providers.expensive;
      if (fallback.length === 0) {
        logger.error("没有任何可用的AI模型配置");
        return null;
      }
      logger.warn({ taskType, tier }, "目标层级无可用模型，降级处理");
      return this.pickHealthy(fallback);
    }

    return this.pickHealthy(candidates);
  }

  /**
   * 从候选列表中选择健康的模型（跳过熔断的）
   */
  private pickHealthy(candidates: ModelProvider[]): ModelProvider | null {
    for (const provider of candidates) {
      const breaker = this.circuitBreakers.get(provider.name);
      if (!breaker || !breaker.isOpen) {
        return provider;
      }

      // 检查熔断恢复（5分钟后半开尝试）
      if (Date.now() - breaker.lastFailure > 5 * 60 * 1000) {
        breaker.isOpen = false;
        breaker.failures = 0;
        logger.info({ provider: provider.name }, "熔断器恢复，重新启用");
        return provider;
      }
    }

    // 所有都熔断了，强制选第一个（总比没有好）
    logger.warn("所有模型均已熔断，强制使用第一个");
    return candidates[0] ?? null;
  }

  /**
   * 记录调用成功
   */
  recordSuccess(providerName: string) {
    const breaker = this.circuitBreakers.get(providerName);
    if (breaker) {
      breaker.failures = 0;
      breaker.isOpen = false;
    }
  }

  /**
   * 记录调用失败
   */
  recordFailure(providerName: string) {
    let breaker = this.circuitBreakers.get(providerName);
    if (!breaker) {
      breaker = { failures: 0, lastFailure: 0, isOpen: false };
      this.circuitBreakers.set(providerName, breaker);
    }

    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= this.threshold) {
      breaker.isOpen = true;
      logger.warn(
        { provider: providerName, failures: breaker.failures },
        "模型熔断器触发，暂停使用该模型"
      );
    }
  }

  /**
   * 获取熔断器状态（用于监控）
   */
  getCircuitBreakerStatus() {
    const status: Record<string, CircuitBreaker> = {};
    for (const [name, breaker] of this.circuitBreakers) {
      status[name] = { ...breaker };
    }
    return status;
  }
}

// 单例
export const modelRouter = new ModelRouter();
