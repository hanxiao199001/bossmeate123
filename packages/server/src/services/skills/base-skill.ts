import type { AIProvider, ChatMessage } from "../ai/providers/base.js";

/** Skill 执行上下文 */
export interface SkillContext {
  tenantId: string;
  userId: string;
  conversationId: string;
  provider: AIProvider;
  ragContext?: string;
  metadata?: Record<string, unknown>;
}

/** Skill 返回结果 */
export interface SkillResult {
  reply: string;
  artifact?: {
    type: string;
    title: string;
    body: string;
    summary?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  };
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
}

/** 所有 Skill 必须实现此接口 */
export interface ISkill {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly preferredTier: "expensive" | "cheap";

  handle(
    userInput: string,
    history: ChatMessage[],
    context: SkillContext
  ): Promise<SkillResult>;
}
