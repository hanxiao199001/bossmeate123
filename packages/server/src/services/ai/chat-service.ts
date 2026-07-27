/**
 * AI 对话服务
 *
 * 负责：
 * 1. 接收用户消息
 * 2. 通过模型路由器选择合适模型
 * 3. 调用模型 API 获取回复（支持 DeepSeek / OpenAI 兼容接口）
 * 4. 记录 Token 使用
 */

import { modelRouter, type TaskType } from "./model-router.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { withRetry } from "../../utils/retry.js";
import { createTimeoutController } from "../../utils/timeout.js";
import { recordLlmUsage } from "../billing/llm-cost.js";
import { AI_FALLBACK_NO_MODEL, AI_FALLBACK_UNAVAILABLE } from "./fallback-messages.js";

/**
 * 7-27: AI 调用失败 → 落 ops_incidents(旁路, 绝不影响原有返回/抛错行为)。
 *
 * 为什么必须记: 7-27 线上 49 次 `This operation was aborted`(60s 超时掐断), ops_incidents
 *   一条都没有 —— 而这批超时正是"20/25 条内容评分为 0、零进草稿箱"的根因。日志里有, 但日志
 *   没人天天看; 昨天刚建的告警体系恰好漏了这一类。
 *
 * 节流: 一次故障会连锁触发几十次(每篇内容都撞), 走 recordIncidentThrottled(10 分钟一条,
 *   被压掉的次数带在 detail.suppressedSinceLastAlert), 免得把别的告警淹了。
 */
function reportAiCallFailure(err: unknown, ctx: { provider: string; model: string; taskType: string; tenantId?: string | null }): void {
  void (async () => {
    try {
      const { isTimeoutLikeError, recordIncidentThrottled } = await import("../ops/incidents.js");
      if (!isTimeoutLikeError(err)) return; // 只记超时/中断类; 额度类由 openai-compatible 的 llm_quota 覆盖
      const msg = err instanceof Error ? err.message : String(err);
      await recordIncidentThrottled({
        kind: "llm_timeout",
        severity: "warn",
        message: `AI 调用超时/中断: ${ctx.provider}/${ctx.model} (${ctx.taskType}) — ${msg.slice(0, 160)}`,
        tenantId: ctx.tenantId ?? null,
        detail: { provider: ctx.provider, model: ctx.model, taskType: ctx.taskType },
      }, { key: `llm_timeout:${ctx.provider}:${ctx.model}` });
    } catch {
      /* 告警旁路失败不影响主流程 */
    }
  })();
}

export interface ChatRequest {
  tenantId: string;
  userId: string;
  conversationId: string;
  message: string;
  skillType?: string;
  context?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  /** 7-06 生成参数透传(RoutedProvider/skills 链路用): 不传保持原默认(temperature 0.7 / 路由表 maxTokens) */
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
}

// OpenAI 兼容接口的响应格式（DeepSeek / Qwen / OpenAI 均使用此格式）
interface OpenAICompatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * skillType → TaskType 映射表
 *
 * 清单来自 `grep -rn "skillType:" packages/server/src --include="*.ts"`，
 * 覆盖所有当前代码实际传入的字符串值。未命中时走兜底（长文本→content_generation，否则→daily_chat）。
 */
const SKILL_TO_TASK_TYPE: Record<string, TaskType> = {
  // 内容生成类
  article: "content_generation",
  video: "content_generation",
  content_generation: "content_generation",
  // 知识检索类
  knowledge_extract: "knowledge_search",
  knowledge_search: "knowledge_search",
  // 质检类
  style_analysis: "quality_check",
  quality_check: "quality_check",
  // 7-27 质检降级槽: 主评分模型(推理型 v4-pro)超时/挂了时改走这个 skillType → 路由到快模型
  quality_check_fast: "quality_check_fast",
  // 其他
  customer_service: "customer_service",
  formatting: "formatting",
  requirement_analysis: "requirement_analysis",
  daily_chat: "daily_chat",
  translation: "translation",
};

/**
 * 根据 skillType 推断任务类型
 */
export function inferTaskType(skillType?: string, message?: string): TaskType {
  let inferredType: TaskType;
  if (skillType && SKILL_TO_TASK_TYPE[skillType]) {
    inferredType = SKILL_TO_TASK_TYPE[skillType];
  } else if (message && message.length > 200) {
    inferredType = "content_generation";
  } else {
    inferredType = "daily_chat";
  }
  logger.debug({ skillType, inferredType }, "TaskType 推断");
  return inferredType;
}

/**
 * 调用 OpenAI 兼容 API（DeepSeek / Qwen / OpenAI）
 *
 * 支持：
 * - 可配置的请求超时（通过 AbortController）
 * - 指数退避重试（仅对速率限制和 5xx 错误）
 */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  timeoutMs: number = env.AI_REQUEST_TIMEOUT_MS,
  temperature: number = 0.7
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  return withRetry(async () => {
    const { controller, cleanup } = createTimeoutController({
      timeoutMs,
      description: `OpenAI compatible API call to ${model}`,
    });

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `API ${response.status}: ${errorBody.slice(0, 200)}`
        );
      }

      const data = (await response.json()) as OpenAICompatResponse;

      const content = data.choices?.[0]?.message?.content || "";
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;

      return { content, inputTokens, outputTokens };
    } finally {
      cleanup();
    }
  });
}

/**
 * 执行 AI 调用（内部辅助函数）
 *
 * systemPrompt 参数保留以维持签名稳定；OpenAI 兼容接口通过 messages 里的 system role 消息传递
 */
async function executeAICall(
  provider: { name: string; model: string; apiKey: string; baseUrl: string; maxTokens: number },
  messages: Array<{ role: string; content: string }>,
  _systemPrompt: string | undefined,
  timeoutMs: number,
  overrides?: { temperature?: number; maxTokens?: number }
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  return await callOpenAICompatible(
    provider.baseUrl,
    provider.apiKey,
    provider.model,
    messages,
    overrides?.maxTokens ?? provider.maxTokens,
    timeoutMs,
    overrides?.temperature
  );
}

/**
 * 7-27 按任务类型差异化超时 —— "一个 AI_REQUEST_TIMEOUT_MS 管全部"是 7-27 事故的放大器。
 *
 * 事故复盘: 现役模型 deepseek-v4-pro 是**推理型**, 出答案前先跑一段思维链, 提示越长越慢。
 *   六维质检那条提示 ~3000 token, 60s 常常返回不完 → AbortController 掐断 → 当天 49 次
 *   "This operation was aborted", 20/25 条内容没评上分。而同一个默认值又管着企微客服 ——
 *   客服那边等 60s 才失败, 用户早跑了; 一刀切往上调到 120s 只会让客服体验更差。
 *   结论: 慢任务要更长, 快任务要更短, 一个数值满足不了两头。
 *
 * 四档(全部可用 env 覆盖, 不改代码就能现场调):
 *   ① quality_check(含降级槽): AI_QUALITY_CHECK_TIMEOUT_MS 默认 180s —— 长提示 + 推理型模型, 给足;
 *      反正超了也有降级重试兜着, 宁可多等也别白花一次推理钱。
 *   ② article/video 生成: AI_ARTICLE_TIMEOUT_MS 默认 120s(原样不动)。
 *   ③ customer_service / daily_chat: AI_FAST_TIMEOUT_MS 默认 45s —— 人在对面等着,
 *      走的是 qwen-plus(非推理型, 实测个位数秒), 45s 已是极宽松的上限; 早失败早走兜底话术。
 *   ④ 其余: AI_REQUEST_TIMEOUT_MS 默认 120s。
 */
export function resolveTimeoutMs(skillType: string | undefined, taskType: TaskType): number {
  if (skillType === "article" || skillType === "video") return env.AI_ARTICLE_TIMEOUT_MS;
  if (taskType === "quality_check" || taskType === "quality_check_fast") return env.AI_QUALITY_CHECK_TIMEOUT_MS;
  if (taskType === "customer_service" || taskType === "daily_chat") return env.AI_FAST_TIMEOUT_MS;
  return env.AI_REQUEST_TIMEOUT_MS;
}

/**
 * 调用 AI 模型获取回复
 *
 * 支持两种回退策略：
 * 1. serial（串行）：主模型失败后，再尝试备选模型
 * 2. race（竞速）：同时请求主备模型，用最先成功的（适合对响应速度敏感的任务）
 */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const taskType = inferTaskType(request.skillType, request.message);

  // 确定超时时间（按任务类型差异化，见 resolveTimeoutMs 的注释）
  const timeoutMs = resolveTimeoutMs(request.skillType, taskType);

  // 构建消息列表
  const messages: Array<{ role: string; content: string }> = [];

  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }

  // 添加历史上下文
  if (request.context) {
    messages.push(...request.context);
  }

  // 添加当前用户消息
  messages.push({ role: "user", content: request.message });

  // 根据策略选择执行方式
  const strategy = modelRouter.getFallbackStrategy();

  const response = strategy === "race"
    ? await chatWithRaceMode(request, messages, taskType, timeoutMs)
    : await chatWithSerialMode(request, messages, taskType, timeoutMs);

  // 7-06: LLM 成本落库(旁路, 不 await 不抛错) — 单出口覆盖 serial/race 全路径。
  // 此前 cost-ledger 的 "llm" 类型 0 写入, token 花费黑盒(战略评估薄弱点#2)。
  void recordLlmUsage({
    tenantId: request.tenantId,
    taskType,
    model: response.model,
    provider: response.provider,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  return response;
}

/**
 * 串行模式：主模型失败后再尝试备选模型
 */
async function chatWithSerialMode(
  request: ChatRequest,
  messages: Array<{ role: string; content: string }>,
  taskType: TaskType,
  timeoutMs: number
): Promise<ChatResponse> {
  const provider = modelRouter.selectModel(taskType);

  if (!provider) {
    logger.error("无可用AI模型");
    return {
      content: AI_FALLBACK_NO_MODEL,
      model: "none",
      provider: "none",
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  logger.info(
    {
      taskType,
      provider: provider.name,
      model: provider.model,
      messageLength: request.message.length,
      contextLength: request.context?.length || 0,
      strategy: "serial",
    },
    "AI 调用开始"
  );

  try {
    const result = await executeAICall(provider, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens });
    modelRouter.recordSuccess(provider.name, provider.model);

    logger.info(
      {
        provider: provider.name,
        model: provider.model,
        taskType,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      "AI 调用成功"
    );

    return {
      content: result.content,
      model: provider.model,
      provider: provider.name,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (err) {
    modelRouter.recordFailure(provider.name, provider.model);
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: errorMsg, provider: provider.name, model: provider.model },
      "AI 调用失败"
    );
    // 7-27: 超时/中断类失败落 ops_incidents(节流)。即使备选救回来了也记 —— 超时本身就是
    //   "钱花了没拿到东西 + 链路在变慢"的信号, 等到主备全挂才告警就晚了。
    reportAiCallFailure(err, { provider: provider.name, model: provider.model, taskType, tenantId: request.tenantId });

    // 尝试备选模型
    const fallback = modelRouter.selectModel(taskType);
    if (fallback && (fallback.name !== provider.name || fallback.model !== provider.model)) {
      logger.info({ fallback: fallback.name, model: fallback.model }, "尝试备选模型");
      try {
        const result = await executeAICall(fallback, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens });
        modelRouter.recordSuccess(fallback.name, fallback.model);
        return {
          content: result.content,
          model: fallback.model,
          provider: fallback.name,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      } catch (fallbackErr) {
        modelRouter.recordFailure(fallback.name, fallback.model);
        logger.error(
          { err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
          "备选模型也失败了"
        );
        reportAiCallFailure(fallbackErr, { provider: fallback.name, model: fallback.model, taskType, tenantId: request.tenantId });
      }
    }

    return {
      content: AI_FALLBACK_UNAVAILABLE,
      model: provider.model,
      provider: provider.name,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

/**
 * 竞速模式：同时请求主备模型，使用最先成功的结果
 * 当两个请求都完成或超时时，取消另一个请求
 */
async function chatWithRaceMode(
  request: ChatRequest,
  messages: Array<{ role: string; content: string }>,
  taskType: TaskType,
  timeoutMs: number
): Promise<ChatResponse> {
  const modelPair = modelRouter.getModelPair(taskType);

  if (!modelPair.primary) {
    logger.error("无可用AI模型");
    return {
      content: AI_FALLBACK_NO_MODEL,
      model: "none",
      provider: "none",
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  logger.info(
    {
      taskType,
      primary: modelPair.primary.name,
      secondary: modelPair.secondary?.name || "none",
      messageLength: request.message.length,
      contextLength: request.context?.length || 0,
      strategy: "race",
    },
    "AI 竞速调用开始"
  );

  // 如果没有备选模型，回退到串行模式
  if (!modelPair.secondary) {
    logger.info("无备选模型，回退到串行模式");
    return await chatWithSerialMode(request, messages, taskType, timeoutMs);
  }

  // 准备两个 Promise，用于竞速
  const primaryPromise = executeAICall(modelPair.primary, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens })
    .then((result) => ({
      success: true as const,
      result,
      provider: modelPair.primary!,
    }))
    .catch((error) => ({
      success: false as const,
      error,
      provider: modelPair.primary!,
    }));

  const secondaryPromise = executeAICall(modelPair.secondary, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens })
    .then((result) => ({
      success: true as const,
      result,
      provider: modelPair.secondary!,
    }))
    .catch((error) => ({
      success: false as const,
      error,
      provider: modelPair.secondary!,
    }));

  try {
    // 使用 Promise.race 获取最先完成的结果
    const winner = await Promise.race([primaryPromise, secondaryPromise]);

    if (winner.success) {
      modelRouter.recordSuccess(winner.provider.name, winner.provider.model);
      logger.info(
        {
          provider: winner.provider.name,
          model: winner.provider.model,
          taskType,
          inputTokens: winner.result.inputTokens,
          outputTokens: winner.result.outputTokens,
        },
        "AI 竞速调用成功"
      );

      return {
        content: winner.result.content,
        model: winner.provider.model,
        provider: winner.provider.name,
        inputTokens: winner.result.inputTokens,
        outputTokens: winner.result.outputTokens,
      };
    } else {
      // 竞速失败，等待另一个请求的结果
      modelRouter.recordFailure(winner.provider.name, winner.provider.model);
      logger.warn(
        {
          failed: winner.provider.name,
          model: winner.provider.model,
          error: winner.error instanceof Error ? winner.error.message : String(winner.error),
        },
        "竞速模式中一个提供商失败，等待备选"
      );
      reportAiCallFailure(winner.error, { provider: winner.provider.name, model: winner.provider.model, taskType, tenantId: request.tenantId });

      const loser = await Promise.race([primaryPromise, secondaryPromise]);
      if (loser.success) {
        modelRouter.recordSuccess(loser.provider.name, loser.provider.model);
        logger.info(
          {
            provider: loser.provider.name,
            model: loser.provider.model,
            taskType,
            inputTokens: loser.result.inputTokens,
            outputTokens: loser.result.outputTokens,
          },
          "AI 竞速调用成功（备选）"
        );

        return {
          content: loser.result.content,
          model: loser.provider.model,
          provider: loser.provider.name,
          inputTokens: loser.result.inputTokens,
          outputTokens: loser.result.outputTokens,
        };
      } else {
        modelRouter.recordFailure(loser.provider.name, loser.provider.model);
        logger.error(
          {
            failed: loser.provider.name,
            error: loser.error instanceof Error ? loser.error.message : String(loser.error),
          },
          "AI 竞速调用两个提供商都失败了"
        );
        reportAiCallFailure(loser.error, { provider: loser.provider.name, model: loser.provider.model, taskType, tenantId: request.tenantId });

        return {
          content: AI_FALLBACK_UNAVAILABLE,
          model: modelPair.primary.model,
          provider: modelPair.primary.name,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "AI 竞速调用异常"
    );

    return {
      content: AI_FALLBACK_UNAVAILABLE,
      model: modelPair.primary.model,
      provider: modelPair.primary.name,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
