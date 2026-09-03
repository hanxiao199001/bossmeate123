/**
 * AI 模型提供商基础接口
 * 所有提供商（Claude、OpenAI、DeepSeek等）都实现这个接口
 */

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * 命中输入缓存的 token 数，**已包含在 inputTokens 内**（与 OpenAI/百炼口径一致）。
   * 9-03 加：账单里缓存是独立计费项（¥1/1M vs ¥12/1M），不区分就会把成本高估。
   * provider 没返回这个字段时为 undefined —— 记账侧按 0 处理，即全部按未命中计价。
   */
  cachedInputTokens?: number;
  finishReason: "stop" | "max_tokens" | "error";
}

export interface StreamChunk {
  content: string;
  done: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AIProvider {
  name: string;

  /** 普通调用（等待完整回复） */
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /** 流式调用（逐字返回） */
  chatStream(
    request: ChatCompletionRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<ChatCompletionResponse>;
}
