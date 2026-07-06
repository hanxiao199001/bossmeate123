/**
 * RoutedProvider — 让 skills(article/video 主链路)走 chat-service 统一网关。
 *
 * 背景(战略评估薄弱点#1): 熔断/按任务路由/主备降级/重试/超时体系全建好了,
 * 但花钱最多的 article-skill(1546行)/video-skill 直连启动时注入的固定 provider:
 * 不走 modelRouter、不触发熔断计数、无 withRetry/超时包裹 —— DeepSeek 一抖主链路裸奔。
 *
 * 本适配器实现 AIProvider 接口(skills 调用点零改动, 红线#11 复用 chat-service 而非重写降级逻辑):
 *   - skillType=article/video → content_generation 路由(primary deepseek-chat / fallback qwen-plus)
 *     + AI_ARTICLE_TIMEOUT_MS 长超时(chat 内按 skillType 判定)
 *     —— 主路径模型与旧直连一致(expensive=deepseek-chat), 无静默模型漂移
 *   - temperature/maxTokens 逐调用透传(ChatRequest 同 commit 新增可选字段), 生成参数语义不变
 *   - 熔断/降级/重试/成本落库(billing/llm-cost)全部自动获得
 *
 * 行为差异说明(有意为之): 旧直连在 HTTP 失败时向上抛错; chat() 在主备全挂时返回
 * "抱歉，AI暂时无法响应…" 文案(model 保持真实名, token=0)。skills 对两种形态都有
 * 现成消化路径(JSON parse 失败 → 各自 fallback/重试), 且换来主备自动切换 —— 净收益为正。
 *
 * 租户归属: skills 是单例、provider 无租户。worker 在 skill.handle 外层
 * runWithLlmCallAttribution 注入(ALS), 此处透传给 chat() 作日志/记账标识。
 */
import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "./providers/base.js";
import { chat } from "./chat-service.js";
import { getLlmCallAttribution } from "../billing/llm-cost.js";

export function createRoutedProvider(skillType: "article" | "video"): AIProvider {
  const call = async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    // messages[] → ChatRequest 形状: system 合并进 systemPrompt, 末条为当前消息, 其余作 context
    const systemPrompt =
      request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
    const rest = request.messages.filter((m) => m.role !== "system");
    const last = rest[rest.length - 1];
    const message = last?.content ?? "";
    const context = rest.slice(0, -1);

    const attribution = getLlmCallAttribution();
    const res = await chat({
      tenantId: attribution?.tenantId ?? "system",
      userId: attribution?.userId ?? "skill-runtime",
      conversationId: attribution?.conversationId ?? `skill-${skillType}`,
      message,
      context: context.length > 0 ? context : undefined,
      systemPrompt,
      skillType, // article/video → content_generation + 长超时
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    });
    return {
      content: res.content,
      model: res.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      finishReason: "stop",
    };
  };

  return {
    name: `routed-${skillType}`,
    chat: call,
    // skills 不用流式; 兜底实现: 完整生成后一次性回吐(满足 AIProvider 契约)
    async chatStream(request: ChatCompletionRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatCompletionResponse> {
      const res = await call(request);
      onChunk({ content: res.content, done: true, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
      return res;
    },
  };
}
