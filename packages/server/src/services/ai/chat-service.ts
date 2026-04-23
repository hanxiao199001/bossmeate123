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

export interface ChatRequest {
  tenantId: string;
  userId: string;
  conversationId: string;
  message: string;
  skillType?: string;
  context?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
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

// Anthropic Claude 响应格式
interface AnthropicResponse {
  id: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * 根据 skillType 推断任务类型
 */
function inferTaskType(skillType?: string, message?: string): TaskType {
  if (skillType === "article") return "content_generation";
  if (skillType === "video") return "content_generation";
  if (skillType === "customer_service") return "customer_service";
  if (skillType === "quality_check") return "quality_check";

  // 根据消息内容简单判断
  if (message && message.length > 200) return "content_generation";

  return "daily_chat";
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
  timeoutMs: number = env.AI_REQUEST_TIMEOUT_MS
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
          temperature: 0.7,
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
 * 调用 Anthropic Claude API
 *
 * 支持：
 * - 可配置的请求超时（通过 AbortController）
 * - 指数退避重试（仅对速率限制和 5xx 错误）
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  systemPrompt?: string,
  timeoutMs: number = env.AI_REQUEST_TIMEOUT_MS
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  // 分离 system 消息
  const systemMsg = systemPrompt || messages.find((m) => m.role === "system")?.content;
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  return withRetry(async () => {
    const { controller, cleanup } = createTimeoutController({
      timeoutMs,
      description: `Anthropic API call to ${model}`,
    });

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemMsg,
          messages: nonSystemMessages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Anthropic API ${response.status}: ${errorBody.slice(0, 200)}`
        );
      }

      const data = (await response.json()) as AnthropicResponse;

      const content = data.content?.[0]?.text || "";
      const inputTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      return { content, inputTokens, outputTokens };
    } finally {
      cleanup();
    }
  });
}

/**
 * 执行 AI 调用（内部辅助函数）
 */
async function executeAICall(
  provider: { name: string; model: string; apiKey: string; baseUrl: string; maxTokens: number },
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string | undefined,
  timeoutMs: number
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  if (provider.name === "anthropic") {
    return await callAnthropic(
      provider.apiKey,
      provider.model,
      messages,
      provider.maxTokens,
      systemPrompt,
      timeoutMs
    );
  } else {
    // DeepSeek / OpenAI / Qwen 均使用 OpenAI 兼容接口
    return await callOpenAICompatible(
      provider.baseUrl,
      provider.apiKey,
      provider.model,
      messages,
      provider.maxTokens,
      timeoutMs
    );
  }
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

  // 确定超时时间（文章生成任务使用更长的超时）
  const isArticleGeneration = request.skillType === "article" || request.skillType === "video";
  const timeoutMs = isArticleGeneration ? env.AI_ARTICLE_TIMEOUT_MS : env.AI_REQUEST_TIMEOUT_MS;

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

  if (strategy === "race") {
    return await chatWithRaceMode(request, messages, taskType, timeoutMs);
  } else {
    return await chatWithSerialMode(request, messages, taskType, timeoutMs);
  }
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
      content: "抱歉，当前没有可用的AI模型，请检查配置。",
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
    const result = await executeAICall(provider, messages, request.systemPrompt, timeoutMs);
    modelRouter.recordSuccess(provider.name);

    logger.info(
      {
        provider: provider.name,
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
    modelRouter.recordFailure(provider.name);
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: errorMsg, provider: provider.name },
      "AI 调用失败"
    );

    // 尝试备选模型
    const fallback = modelRouter.selectModel(taskType);
    if (fallback && fallback.name !== provider.name) {
      logger.info({ fallback: fallback.name }, "尝试备选模型");
      try {
        const result = await executeAICall(fallback, messages, request.systemPrompt, timeoutMs);
        modelRouter.recordSuccess(fallback.name);
        return {
          content: result.content,
          model: fallback.model,
          provider: fallback.name,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      } catch (fallbackErr) {
        modelRouter.recordFailure(fallback.name);
        logger.error(
          { err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
          "备选模型也失败了"
        );
      }
    }

    return {
      content: "抱歉，AI暂时无法响应，请稍后重试。",
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
      content: "抱歉，当前没有可用的AI模型，请检查配置。",
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
  const primaryPromise = executeAICall(modelPair.primary, messages, request.systemPrompt, timeoutMs)
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

  const secondaryPromise = executeAICall(modelPair.secondary, messages, request.systemPrompt, timeoutMs)
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
      modelRouter.recordSuccess(winner.provider.name);
      logger.info(
        {
          provider: winner.provider.name,
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
      modelRouter.recordFailure(winner.provider.name);
      logger.warn(
        {
          failed: winner.provider.name,
          error: winner.error instanceof Error ? winner.error.message : String(winner.error),
        },
        "竞速模式中一个提供商失败，等待备选"
      );

      const loser = await Promise.race([primaryPromise, secondaryPromise]);
      if (loser.success) {
        modelRouter.recordSuccess(loser.provider.name);
        logger.info(
          {
            provider: loser.provider.name,
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
        modelRouter.recordFailure(loser.provider.name);
        logger.error(
          {
            failed: loser.provider.name,
            error: loser.error instanceof Error ? loser.error.message : String(loser.error),
          },
          "AI 竞速调用两个提供商都失败了"
        );

        return {
          content: "抱歉，AI暂时无法响应，请稍后重试。",
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
      content: "抱歉，AI暂时无法响应，请稍后重试。",
      model: modelPair.primary.model,
      provider: modelPair.primary.name,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
