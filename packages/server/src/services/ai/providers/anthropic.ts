/**
 * Anthropic Claude 提供商
 * 用于核心内容生成、需求分析、质检等高质量任务
 */

import { logger } from "../../../config/logger.js";
import type {
  AIProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
} from "./base.js";

export class AnthropicProvider implements AIProvider {
  name = "anthropic";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = request.model || "claude-sonnet-4-20250514";
    const maxTokens = request.maxTokens || 4096;

    // 提取 system 消息
    const systemMsg = request.messages.find((m) => m.role === "system");
    const userMessages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature: request.temperature ?? 0.7,
      messages: userMessages,
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    logger.debug({ model, messageCount: userMessages.length }, "Anthropic 调用开始");

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, "Anthropic API 错误");
      throw new Error(`Anthropic API 错误: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };

    const content = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    logger.info(
      {
        model: data.model,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
      "Anthropic 调用成功"
    );

    return {
      content,
      model: data.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      finishReason: data.stop_reason === "end_turn" ? "stop" : "max_tokens",
    };
  }

  async chatStream(
    request: ChatCompletionRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ChatCompletionResponse> {
    const model = request.model || "claude-sonnet-4-20250514";
    const maxTokens = request.maxTokens || 4096;

    const systemMsg = request.messages.find((m) => m.role === "system");
    const userMessages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature: request.temperature ?? 0.7,
      messages: userMessages,
      stream: true,
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic Stream 错误: ${response.status} - ${error}`);
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

          if (event.type === "content_block_delta" && event.delta?.text) {
            fullContent += event.delta.text;
            onChunk({ content: event.delta.text, done: false });
          }

          if (event.type === "message_delta" && event.usage) {
            outputTokens = event.usage.output_tokens;
          }

          if (event.type === "message_start" && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens;
          }
        } catch {
          // 忽略解析错误
        }
      }
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
