/**
 * AI 模型路由器（T2 重构）
 *
 * 核心逻辑：TaskType → 具体模型（providerName + modelName）直映射
 *   - DeepSeek-Reasoner：requirement_analysis / quality_check / knowledge_search
 *   - DeepSeek-Chat：content_generation
 *   - Qwen-Plus：daily_chat / formatting / customer_service / translation
 * 熔断 key = `${providerName}:${modelName}`，避免同厂商不同模型互相干扰。
 *
 * 熔断机制：失败 N 次自动跳过，5 分钟后半开重试
 * 回退策略：可配置为 serial（失败重试备选）或 race（同时请求主备）
 * 兼容：`getProviders().expensive / cheap` 保留给 14 处 `getProvider("expensive")` / `getProvider("cheap")`
 * 以及 agent-status 路由，内部 expensive = content_generation.primary，cheap = daily_chat.primary。
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export type FallbackStrategy = "serial" | "race";

// 任务类型定义
export type TaskType =
  | "content_generation"   // 内容生成（图文、脚本）
  | "requirement_analysis" // 需求理解和拆解
  | "quality_check"        // 质检校准
  | "knowledge_search"     // 知识库检索增强
  | "daily_chat"           // 日常问答
  | "formatting"           // 格式化处理
  | "customer_service"     // 常规客服
  | "translation";         // 翻译

// 模型提供商配置
export interface ModelProvider {
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

// 模型选择：某一 TaskType 对应的具体模型
interface ModelChoice {
  providerName: "deepseek" | "qwen";
  modelName: string;
}

/** TaskType → 具体模型直映射（primary + fallback） */
function buildTaskRoute(): Record<TaskType, { primary: ModelChoice; fallback: ModelChoice }> {
  return {
    content_generation:   { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT },     fallback: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS } },
    requirement_analysis: { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    quality_check:        { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    knowledge_search:     { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS } },
    daily_chat:           { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    formatting:           { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    customer_service:     { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    translation:          { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  };
}

/** Provider 基础信息（API Key / baseUrl）按 providerName 查 */
function getProviderMeta(name: "deepseek" | "qwen"): { apiKey: string; baseUrl: string } | null {
  if (name === "deepseek" && env.DEEPSEEK_API_KEY) {
    return { apiKey: env.DEEPSEEK_API_KEY, baseUrl: "https://api.deepseek.com/v1" };
  }
  if (name === "qwen" && env.QWEN_API_KEY) {
    return { apiKey: env.QWEN_API_KEY, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" };
  }
  return null;
}

/** 把 ModelChoice 物化为 ModelProvider（含 apiKey/baseUrl）；缺 Key 时返回 null */
function materializeChoice(choice: ModelChoice): ModelProvider | null {
  const meta = getProviderMeta(choice.providerName);
  if (!meta) return null;
  return {
    name: choice.providerName,
    model: choice.modelName,
    apiKey: meta.apiKey,
    baseUrl: meta.baseUrl,
    maxTokens: 4096,
  };
}

/** 熔断器 key：避免同厂商不同模型互相干扰 */
function breakerKey(providerName: string, modelName: string): string {
  return `${providerName}:${modelName}`;
}

class ModelRouter {
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private threshold: number;
  private fallbackStrategy: FallbackStrategy;

  constructor() {
    this.threshold = env.MODEL_CIRCUIT_BREAKER_THRESHOLD;
    this.fallbackStrategy = env.AI_FALLBACK_STRATEGY;
  }

  /**
   * 兼容别名：返回按 "tier" 分组的 provider 列表
   *
   *   expensive = content_generation 的 primary（DeepSeek-Chat）
   *   cheap     = daily_chat 的 primary（Qwen-Plus）
   *
   * provider-factory.ts 和 agent-status.ts 依赖此签名。
   */
  getProviders(): { expensive: ModelProvider[]; cheap: ModelProvider[] } {
    const route = buildTaskRoute();
    const expensive: ModelProvider[] = [];
    const cheap: ModelProvider[] = [];

    const contentPrimary = materializeChoice(route.content_generation.primary);
    if (contentPrimary) expensive.push(contentPrimary);

    const dailyPrimary = materializeChoice(route.daily_chat.primary);
    if (dailyPrimary) cheap.push(dailyPrimary);

    // 如果任一层级空：降级（用另一层代替），保留原有兜底语义
    if (expensive.length === 0 && cheap.length > 0) {
      expensive.push(...cheap);
    }
    if (cheap.length === 0 && expensive.length > 0) {
      cheap.push(...expensive);
    }

    return { expensive, cheap };
  }

  /**
   * 根据任务类型选择模型（按 TASK_ROUTE primary → fallback 顺序，跳过已熔断）
   */
  selectModel(taskType: TaskType): ModelProvider | null {
    const route = buildTaskRoute()[taskType];
    const candidates: ModelProvider[] = [];

    const primary = materializeChoice(route.primary);
    if (primary) candidates.push(primary);

    // fallback 不重复 primary（同 provider+同 model 即视为一样）
    if (
      route.fallback.providerName !== route.primary.providerName ||
      route.fallback.modelName !== route.primary.modelName
    ) {
      const fb = materializeChoice(route.fallback);
      if (fb) candidates.push(fb);
    }

    if (candidates.length === 0) {
      logger.error({ taskType }, "没有任何可用的AI模型配置");
      return null;
    }

    return this.pickHealthy(candidates);
  }

  /**
   * 从候选列表中选择健康的模型（跳过熔断的）
   */
  private pickHealthy(candidates: ModelProvider[]): ModelProvider | null {
    for (const provider of candidates) {
      const breaker = this.circuitBreakers.get(breakerKey(provider.name, provider.model));
      if (!breaker || !breaker.isOpen) {
        return provider;
      }

      // 检查熔断恢复（5分钟后半开尝试）
      if (Date.now() - breaker.lastFailure > 5 * 60 * 1000) {
        breaker.isOpen = false;
        breaker.failures = 0;
        logger.info({ provider: provider.name, model: provider.model }, "熔断器恢复，重新启用");
        return provider;
      }
    }

    // 所有都熔断了，强制选第一个（总比没有好）
    logger.warn("所有模型均已熔断，强制使用第一个");
    return candidates[0] ?? null;
  }

  /**
   * 记录调用成功（熔断器 key = providerName:modelName）
   */
  recordSuccess(providerName: string, modelName: string) {
    const breaker = this.circuitBreakers.get(breakerKey(providerName, modelName));
    if (breaker) {
      breaker.failures = 0;
      breaker.isOpen = false;
    }
  }

  /**
   * 记录调用失败（熔断器 key = providerName:modelName）
   */
  recordFailure(providerName: string, modelName: string) {
    const key = breakerKey(providerName, modelName);
    let breaker = this.circuitBreakers.get(key);
    if (!breaker) {
      breaker = { failures: 0, lastFailure: 0, isOpen: false };
      this.circuitBreakers.set(key, breaker);
    }

    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= this.threshold) {
      breaker.isOpen = true;
      logger.warn(
        { provider: providerName, model: modelName, failures: breaker.failures },
        "模型熔断器触发，暂停使用该模型"
      );
    }
  }

  /**
   * 获取熔断器状态（用于监控）—— key 格式 "providerName:modelName"
   */
  getCircuitBreakerStatus() {
    const status: Record<string, CircuitBreaker> = {};
    for (const [key, breaker] of this.circuitBreakers) {
      status[key] = { ...breaker };
    }
    return status;
  }

  /**
   * 获取回退策略
   */
  getFallbackStrategy(): FallbackStrategy {
    return this.fallbackStrategy;
  }

  /**
   * 为指定任务类型获取主和备选模型
   * 用于支持竞速模式（race）或串行模式（serial）
   */
  getModelPair(
    taskType: TaskType
  ): { primary: ModelProvider | null; secondary: ModelProvider | null } {
    const route = buildTaskRoute()[taskType];
    const primary = materializeChoice(route.primary);
    const fallback = materializeChoice(route.fallback);

    // 排除已熔断的作为 primary
    const primaryHealthy =
      primary && !this.isBreakerOpen(primary) ? primary : null;
    const fallbackHealthy =
      fallback && !this.isBreakerOpen(fallback) ? fallback : null;

    // 如果 primary 健康：primary + fallback（无论 fallback 是否熔断，至少给个备选）
    if (primaryHealthy) {
      return { primary: primaryHealthy, secondary: fallback && fallback.model !== primary!.model ? fallback : null };
    }

    // primary 熔断或缺失：fallback 上位
    if (fallbackHealthy) {
      return { primary: fallbackHealthy, secondary: null };
    }

    // 都熔断：返回任意可用（即使熔断）
    if (primary) return { primary, secondary: fallback };
    if (fallback) return { primary: fallback, secondary: null };

    logger.error({ taskType }, "没有任何可用的AI模型配置");
    return { primary: null, secondary: null };
  }

  private isBreakerOpen(provider: ModelProvider): boolean {
    const breaker = this.circuitBreakers.get(breakerKey(provider.name, provider.model));
    return !!breaker && breaker.isOpen;
  }
}

// 单例
export const modelRouter = new ModelRouter();
