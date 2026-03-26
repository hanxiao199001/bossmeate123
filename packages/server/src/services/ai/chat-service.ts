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
 */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
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
}

/**
 * 调用 Anthropic Claude API
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  systemPrompt?: string
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  // 分离 system 消息
  const systemMsg = systemPrompt || messages.find((m) => m.role === "system")?.content;
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

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
}

/**
 * 调用 AI 模型获取回复
 */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const taskType = inferTaskType(request.skillType, request.message);
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

  logger.info(
    {
      taskType,
      provider: provider.name,
      model: provider.model,
      messageLength: request.message.length,
      contextLength: request.context?.length || 0,
    },
    "AI 调用开始"
  );

  try {
    let result: { content: string; inputTokens: number; outputTokens: number };

    if (provider.name === "anthropic") {
      result = await callAnthropic(
        provider.apiKey,
        provider.model,
        messages,
        provider.maxTokens,
        request.systemPrompt
      );
    } else {
      // DeepSeek / OpenAI / Qwen 均使用 OpenAI 兼容接口
      result = await callOpenAICompatible(
        provider.baseUrl,
        provider.apiKey,
        provider.model,
        messages,
        provider.maxTokens
      );
    }

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
        let result;
        if (fallback.name === "anthropic") {
          result = await callAnthropic(
            fallback.apiKey,
            fallback.model,
            messages,
            fallback.maxTokens,
            request.systemPrompt
          );
        } else {
          result = await callOpenAICompatible(
            fallback.baseUrl,
            fallback.apiKey,
            fallback.model,
            messages,
            fallback.maxTokens
          );
        }

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
        logger.error({ err: fallbackErr }, "备选模型也失败了");
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
