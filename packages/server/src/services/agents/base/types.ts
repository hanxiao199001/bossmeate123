/**
 * Agent 系统核心类型定义
 */

export type AgentStatus = "idle" | "running" | "paused" | "error" | "shutdown";

export interface AgentConfig {
  tenantId?: string;
  concurrency: number;
  maxRetries: number;
  timeoutMs: number;
  settings?: Record<string, unknown>;
}

export interface AgentContext {
  tenantId: string;
  date: string;            // YYYY-MM-DD
  plan?: unknown;
  triggeredBy: "scheduler" | "manual" | "event";
  runId?: string;          // 用于 SSE 进度推送
}

export interface AgentTask {
  id: string;
  agentName: string;
  type: string;
  priority: "urgent" | "high" | "normal" | "low";
  input: Record<string, unknown>;
  deadline?: string;
  retryCount: number;
}

export interface AgentTaskResult {
  taskId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  metrics?: {
    durationMs: number;
    tokensUsed: number;
  };
}

export interface AgentResult {
  agentName: string;
  success: boolean;
  tasksCompleted: number;
  tasksFailed: number;
  summary: string;
  details?: unknown[];
  durationMs: number;
}

export interface IAgent {
  readonly name: string;
  readonly displayName: string;

  initialize(config: AgentConfig): Promise<void>;
  execute(context: AgentContext): Promise<AgentResult>;
  handleTask(task: AgentTask): Promise<AgentTaskResult>;
  getStatus(): AgentStatus;
  shutdown(): Promise<void>;
}
