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
import { getLlmEndpoint } from "./llm-endpoints.js";

export type FallbackStrategy = "serial" | "race";

// 任务类型定义
export type TaskType =
  | "content_generation"   // 内容生成（图文、脚本）
  | "requirement_analysis" // 需求理解和拆解
  | "quality_check"        // 质检校准
  | "quality_check_fast"   // 7-27 质检降级槽: 主评分模型超时时改走快模型重评(见下方路由表注释)
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
    // 7-30 fallback 换成跨厂商: 原来是 deepseek/CHAT, 而 REASONER 与 CHAT 两个 env 现在都是
    //   deepseek-v4-pro → selectModel 去重把 fallback 丢掉 = 主模型一挂即全线停。
    //   这一条是假兜底守卫(assertNoDegenerateFallback)当场抓出来的, 之前只知道 quality_check 有问题。
    //   与 quality_check 不同, 本槽没有"要保留升级动作可观测性"的理由, 所以直接改成真兜底。
    requirement_analysis: { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS } },
    quality_check:        { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    // ⚠️ 7-27 质检降级槽 —— 全系统唯一没有**跨厂商**兜底的链路, 事故当天就栽在这里。
    //   为什么 quality_check 那一行等于没有兜底: DEEPSEEK_MODEL_REASONER 与 DEEPSEEK_MODEL_CHAT
    //   现在都默认 deepseek-v4-pro(同一个模型名) → selectModel 的去重把 fallback 直接丢掉,
    //   chatWithSerialMode 里 `fallback.model !== provider.model` 也永远为 false → 主模型超时 = 直接凉。
    //   本槽固定指向**另一个厂商的非推理型模型**(qwen-plus): 推理型超时是模型自身属性,
    //   换一个同厂同架构的兄弟模型救不了; 只有换掉"推理"这个变量才是真兜底。
    quality_check_fast:   { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    knowledge_search:     { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS } },
    daily_chat:           { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    formatting:           { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    customer_service:     { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
    translation:          { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  };
}

/**
 * Provider 基础信息（API Key / baseUrl）按 providerName 查。
 *
 * 7-26: baseURL 与 key 不再硬编码在这里 —— 统一由 services/ai/llm-endpoints.ts 解析
 * （DEEPSEEK_VIA 一个开关同时切 baseURL 与 key，避免"只改一半"导致全量 401）。
 * 默认值与改造前完全一致：deepseek → api.deepseek.com/v1，qwen → 百炼 compatible-mode。
 */
function getProviderMeta(name: "deepseek" | "qwen"): { apiKey: string; baseUrl: string } | null {
  const ep = getLlmEndpoint(name);
  return ep ? { apiKey: ep.apiKey, baseUrl: ep.baseUrl } : null;
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

// ============ 7-30 假兜底守卫 ============
//
// 病史: `quality_check` 那行写着 primary=REASONER / fallback=CHAT, 看着有兜底; 而两个 env
//   现在都是 deepseek-v4-pro → selectModel 的去重把 fallback 丢掉, getModelPair 里
//   `fallback.model !== primary.model` 也永远 false → **主模型一挂就直接凉**。
//   7-27 质检零产出事故就栽在这。当时补了注释, 但注释救不了下一个读代码的人 ——
//   这个项目已经反复证明过(分区判据踩两次、保底口径两处各写各的)。
//
// 所以改成机器判定: 任何 primary 与 fallback 解析到**同一 provider + 同一模型**的路由,
//   要么改成真兜底, 要么在下面显式声明"由哪个槽补偿", 而那个补偿槽会被一并校验
//   (它自己不许退化, 且必须跨厂商)。写不出沉默的假兜底。

/** 允许退化的路由 —— 必须写明由哪个槽补偿, 以及为什么不让路由层自己兜 */
const DEGENERATE_FALLBACK_ALLOWED: Partial<Record<TaskType, { compensatedBy: TaskType; reason: string }>> = {
  quality_check: {
    compensatedBy: "quality_check_fast",
    reason:
      "刻意不让路由层自己兜: 若 quality_check 的 fallback 直接指向 qwen, 那 qwen 出的分会被记成 " +
      "tier=primary, quality_check_degraded 告警就不会响 —— 等于丢掉『主模型不可用』这个信号。" +
      "改由 quality-check-v2 显式把 skillType 切到 quality_check_fast(跨厂商 qwen-plus)升级, " +
      "升级动作因此是可观测的(scorerModel + degraded incident 都落库)。",
  },
};

export interface DegenerateFallbackIssue {
  taskType: TaskType;
  provider: string;
  model: string;
  /** 声明了补偿槽但补偿槽自己也不合格时的说明 */
  problem: "undeclared" | "compensator_degenerate" | "compensator_same_vendor";
}

/**
 * 纯函数: 找出所有"假兜底"(primary 与 fallback 完全相同)且未被正当补偿的路由。
 * 与 selectModel 的去重条件逐字对应 —— 那里认为"相同"的, 这里就该判退化。
 */
export function findDegenerateFallbacks(): DegenerateFallbackIssue[] {
  const route = buildTaskRoute();
  const issues: DegenerateFallbackIssue[] = [];
  const same = (a: ModelChoice, b: ModelChoice) =>
    a.providerName === b.providerName && a.modelName === b.modelName;

  for (const [tt, r] of Object.entries(route) as Array<[TaskType, { primary: ModelChoice; fallback: ModelChoice }]>) {
    if (!same(r.primary, r.fallback)) continue;

    const allow = DEGENERATE_FALLBACK_ALLOWED[tt];
    const base = { taskType: tt, provider: r.primary.providerName, model: r.primary.modelName };
    if (!allow) { issues.push({ ...base, problem: "undeclared" }); continue; }

    // 补偿槽自己不能也是假兜底, 而且必须换厂商(同厂商同一批故障会一起挂)
    const comp = route[allow.compensatedBy];
    if (!comp || same(comp.primary, comp.fallback)) {
      issues.push({ ...base, problem: "compensator_degenerate" });
    } else if (comp.primary.providerName === r.primary.providerName) {
      issues.push({ ...base, problem: "compensator_same_vendor" });
    }
  }
  return issues;
}

/**
 * 启动期自检 —— **只告警, 永不抛**。
 *
 * ⚠️ 7-30 血的教训: 这个函数第一版在 production 下 `throw`, 部署后服务**直接起不来**
 *   (health 000), 因为 `requirement_analysis` 也是退化路由且未声明 —— 一个**早就存在**的
 *   状态。对存量状态加一道会抛的断言, 等于自己制造停机: 断言想防的是"以后别再写出假兜底",
 *   而它实际做的是"把历史欠账变成当场宕机"。
 *
 *   正确的分工:
 *     · **测试**负责阻断 —— 新写出假兜底 → llm-json-repair.test.ts 红 → 合不进去(零线上风险)
 *     · **运行期**只负责告知 —— 日志 error + ops_incident, 让存量欠账可见但不停服
 *
 *   同理适用于任何"给既有系统加校验"的场合: 先 warn 一段时间、看清存量面, 再考虑收紧。
 */
export function assertNoDegenerateFallback(): void {
  const issues = findDegenerateFallbacks();
  if (issues.length === 0) return;
  const detail = issues
    .map((i) => `  · ${i.taskType}: primary 与 fallback 都是 ${i.provider}/${i.model} (${i.problem})`)
    .join("\n");
  logger.error(
    { issues },
    "⚠️ 假兜底路由(primary 与 fallback 同一模型, 主模型一挂即全线停):\n" + detail +
      "\n改法: ① fallback 换成另一个厂商的模型; ② 刻意如此则在 DEGENERATE_FALLBACK_ALLOWED 声明补偿槽。",
  );
  // 旁路落 incident, 让它进次日简报而不是只躺在日志里
  void import("../ops/incidents.js")
    .then((m) => m.recordIncidentThrottled({
      kind: "degenerate_fallback_route",
      severity: "warn",
      message: `${issues.length} 条路由是假兜底(主模型一挂即全线停): ${issues.map((i) => i.taskType).join(", ")}`,
      detail: { issues },
    }, { key: "degenerate_fallback_route" }))
    .catch(() => { /* 告警旁路 */ });
}

// 单例
export const modelRouter = new ModelRouter();
