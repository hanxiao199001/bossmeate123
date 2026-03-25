/**
 * AI 对话服务
 *
 * 负责：
 * 1. 接收用户消息
 * 2. 通过模型路由器选择合适模型
 * 3. 调用模型 API 获取回复
 * 4. 记录 Token 使用
 *
 * TODO: 第二阶段完善 —— 流式输出、多轮追问、RAG知识库检索
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
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 根据 skillType 推断任务类型
 */
function inferTaskType(skillType?: string, message?: string): TaskType {
  if (skillType === "article") return "content_generation";
  if (skillType === "video") return "content_generation";
  if (skillType === "customer_service") return "customer_service";

  // 根据消息内容简单判断（后续用更智能的分类器）
  if (message && message.length > 200) return "content_generation";

  return "daily_chat";
}

/**
 * 调用 AI 模型获取回复
 *
 * 当前为占位实现，后续替换为实际 API 调用
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

  logger.info(
    {
      taskType,
      provider: provider.name,
      model: provider.model,
      messageLength: request.message.length,
    },
    "AI 调用开始"
  );

  try {
    // TODO: 实际 API 调用
    // 当前返回占位回复
    const response: ChatResponse = {
      content: `[${provider.name}/${provider.model}] 这是一个占位回复。实际的AI调用将在模型API集成后启用。\n\n您的消息: "${request.message.slice(0, 100)}"`,
      model: provider.model,
      provider: provider.name,
      inputTokens: Math.ceil(request.message.length / 4),
      outputTokens: 50,
    };

    modelRouter.recordSuccess(provider.name);
    logger.info({ provider: provider.name, taskType }, "AI 调用成功");

    return response;
  } catch (err) {
    modelRouter.recordFailure(provider.name);
    logger.error({ err, provider: provider.name }, "AI 调用失败");

    // 熔断后尝试备选模型
    const fallback = modelRouter.selectModel(taskType);
    if (fallback && fallback.name !== provider.name) {
      logger.info({ fallback: fallback.name }, "尝试备选模型");
      // TODO: 实际调用备选模型
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
