/**
 * OpenAI 兼容接口提供商
 * 支持：OpenAI、DeepSeek、通义千问、Kimi 等所有兼容 OpenAI 格式的模型
 */

import { logger } from "../../../config/logger.js";
import type {
  AIProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "./base.js";

export class OpenAICompatibleProvider implements AIProvider {
  name: string;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(
    name: string,
    apiKey: string,
    baseUrl: string,
    defaultModel: string
  ) {
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.defaultModel = defaultModel;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = request.model || this.defaultModel;

    const body = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
      stream: false,
    };

    logger.debug(
      { provider: this.name, model, messageCount: request.messages.length },
      "OpenAI兼容 调用开始"
    );

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error(
        { provider: this.name, status: response.status, error },
        "API 错误"
      );
      throw new Error(`${this.name} API 错误: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      model: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
      };
    };

    const content = data.choices[0]?.message?.content || "";

    logger.info(
      {
        provider: this.name,
        model: data.model,
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      "调用成功"
    );

    return {
      content,
      model: data.model,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      finishReason:
        data.choices[0]?.finish_reason === "stop" ? "stop" : "max_tokens",
    };
  }

  async chatStream(
    request: ChatCompletionRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ChatCompletionResponse> {
    const model = request.model || this.defaultModel;

    const body = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `${this.name} Stream 错误: ${response.status} - ${error}`
      );
    }

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) throw new Error("无法获取响应流");

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta?.content;

          if (delta) {
            fullContent += delta;
            onChunk({ content: delta, done: false });
          }

          // 部分模型在最后一个 chunk 返回 usage
          if (event.usage) {
            inputTokens = event.usage.prompt_tokens || 0;
            outputTokens = event.usage.completion_tokens || 0;
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    // 估算 token（如果流式没返回 usage）
    if (inputTokens === 0) {
      const totalChars = request.messages.reduce(
        (sum, m) => sum + m.content.length,
        0
      );
      inputTokens = Math.ceil(totalChars / 3);
    }
    if (outputTokens === 0) {
      outputTokens = Math.ceil(fullContent.length / 3);
    }

    onChunk({ content: "", done: true, inputTokens, outputTokens });

    return {
      content: fullContent,
      model,
      inputTokens,
      outputTokens,
      finishReason: "stop",
    };
  }
}
