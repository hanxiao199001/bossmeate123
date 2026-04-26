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
  /**
   * 多版本生成（T4 人机协作 critique-rewrite）副版本数组。
   *
   * 主版本仍走 artifact 字段；副版本（variantIndex >= 1）放这里。
   * content-worker 负责写多 contents 行 + productionRecords parentId 串联到主版本 contentId。
   * 空/undefined = 单版本 skill（向后兼容）。
   */
  extraArtifacts?: Array<{
    type: string;
    title: string;
    body: string;
    summary?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }>;
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
