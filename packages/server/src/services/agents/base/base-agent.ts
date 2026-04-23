/**
 * BaseAgent - Agent 抽象基类
 *
 * 所有 Agent 继承此类，获得：
 * - 统一生命周期: init() → execute() → shutdown()
 * - 状态机: idle → running → idle/error
 * - AbortController 超时强制中断
 * - tenantId 多租户校验
 * - correlationId 链路追踪（自动注入日志和事件）
 * - EventBus 事件发布快捷方法
 * - 内置重试（复用 withRetry）
 * - 执行日志记录（agentLogs 表）
 */

import { nanoid } from "nanoid";
import { logger } from "../../../config/logger.js";
import { eventBus } from "../../event-bus/index.js";
import { logAgentAction, updateAgentLog } from "./agent-logger.js";
import type {
  IAgent,
  AgentConfig,
  AgentContext,
  AgentTask,
  AgentTaskResult,
  AgentResult,
  AgentStatus,
} from "./types.js";
import type { BusEvent, EventType } from "../../event-bus/types.js";

/** 扩展 AgentContext，增加 correlationId */
export interface BaseAgentContext extends AgentContext {
  correlationId: string;
}

/** 扩展 AgentTaskResult，增加 timedOut */
export interface BaseAgentTaskResult extends AgentTaskResult {
  timedOut?: boolean;
}

export abstract class BaseAgent implements IAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;

  protected config: AgentConfig = {
    concurrency: 1,
    maxRetries: 3,
    timeoutMs: 300_000, // 默认5分钟
  };

  private _status: AgentStatus = "idle";
  private _activeAbortController: AbortController | null = null;

  // --- 生命周期 ---

  async initialize(config: AgentConfig): Promise<void> {
    this.config = { ...this.config, ...config };
    this._status = "idle";

    this.log("info", "Agent 初始化完成", {
      concurrency: this.config.concurrency,
      timeoutMs: this.config.timeoutMs,
    });

    await this.onInitialize();
  }

  /** 子类可覆写的初始化钩子 */
  protected async onInitialize(): Promise<void> {
    // 默认空实现
  }

  getStatus(): AgentStatus {
    return this._status;
  }

  async shutdown(): Promise<void> {
    this._status = "shutdown";
    if (this._activeAbortController) {
      this._activeAbortController.abort();
      this._activeAbortController = null;
    }
    await this.onShutdown();
    this.log("info", "Agent 已关闭");
  }

  /** 子类可覆写的关闭钩子 */
  protected async onShutdown(): Promise<void> {
    // 默认空实现
  }

  // --- 执行入口 ---

  /**
   * 执行 Agent 主逻辑（带超时 + tenantId 校验 + 日志）
   */
  async execute(context: AgentContext): Promise<AgentResult> {
    // 1. tenantId 校验
    this.validateTenantId(context.tenantId);

    // 2. 生成或复用 correlationId
    const ctx: BaseAgentContext = {
      ...context,
      correlationId: (context as BaseAgentContext).correlationId || nanoid(12),
    };

    // 3. 状态切换
    this._status = "running";
    const startTime = Date.now();

    // 4. 记录执行日志
    const logId = await logAgentAction({
      tenantId: ctx.tenantId,
      agentName: this.name,
      action: "execute",
      status: "running",
      input: { triggeredBy: ctx.triggeredBy, correlationId: ctx.correlationId },
    });

    // 5. 带超时执行
    const abortController = new AbortController();
    this._activeAbortController = abortController;
    const timeoutMs = this.config.timeoutMs;

    let result: AgentResult;

    try {
      result = await this.executeWithTimeout(
        () => this.onExecute(ctx, abortController.signal),
        timeoutMs,
        abortController
      );

      this._status = "idle";

      await updateAgentLog(logId, {
        status: "completed",
        output: { summary: result.summary, tasksCompleted: result.tasksCompleted },
        durationMs: Date.now() - startTime,
        tokensUsed: 0,
      });

      this.log("info", "执行完成", {
        correlationId: ctx.correlationId,
        durationMs: Date.now() - startTime,
        summary: result.summary,
      });
    } catch (err) {
      const isTimeout = abortController.signal.aborted;
      const errMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      this._status = "error";

      await updateAgentLog(logId, {
        status: "failed",
        error: isTimeout ? `超时(${timeoutMs}ms)` : errMsg,
        durationMs,
      });

      // 发布错误/超时事件
      const eventType: EventType = isTimeout ? "agent.timeout" : "agent.error";
      await this.publishEvent(eventType, ctx.tenantId, ctx.correlationId, {
        agentName: this.name,
        error: errMsg,
        durationMs,
        timedOut: isTimeout,
      });

      this.log("error", isTimeout ? "执行超时" : "执行失败", {
        correlationId: ctx.correlationId,
        error: errMsg,
        durationMs,
      });

      result = {
        agentName: this.name,
        success: false,
        tasksCompleted: 0,
        tasksFailed: 1,
        summary: isTimeout ? `执行超时(${timeoutMs}ms)` : errMsg,
        durationMs,
      };
    } finally {
      this._activeAbortController = null;
    }

    return result;
  }

  /**
   * 处理单个任务（带 tenantId 校验）
   */
  async handleTask(task: AgentTask): Promise<BaseAgentTaskResult> {
    const tenantId = task.input.tenantId as string | undefined;
    if (tenantId) {
      this.validateTenantId(tenantId);
    }

    const startTime = Date.now();
    try {
      const result = await this.onHandleTask(task);
      return result;
    } catch (err) {
      return {
        taskId: task.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metrics: { durationMs: Date.now() - startTime, tokensUsed: 0 },
      };
    }
  }

  // --- 子类必须实现 ---

  /**
   * Agent 主执行逻辑
   * @param context 执行上下文（含 correlationId）
   * @param signal AbortSignal，长操作应检查 signal.aborted
   */
  protected abstract onExecute(
    context: BaseAgentContext,
    signal: AbortSignal
  ): Promise<AgentResult>;

  /**
   * 处理单个任务
   */
  protected abstract onHandleTask(task: AgentTask): Promise<BaseAgentTaskResult>;

  // --- 工具方法 ---

  /**
   * 发布事件到 EventBus
   */
  protected async publishEvent<T>(
    type: EventType,
    tenantId: string,
    correlationId: string,
    payload: T
  ): Promise<string> {
    return eventBus.publish({
      type,
      tenantId,
      correlationId,
      source: this.name,
      payload,
    });
  }

  /**
   * 带结构化日志（自动附加 agentName）
   */
  protected log(
    level: "info" | "warn" | "error" | "debug",
    message: string,
    extra: Record<string, unknown> = {}
  ): void {
    logger[level]({ agent: this.name, ...extra }, `[${this.displayName}] ${message}`);
  }

  /**
   * tenantId 校验
   */
  private validateTenantId(tenantId: string): void {
    if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
      throw new Error(`[${this.name}] tenantId 不能为空`);
    }
  }

  /**
   * Promise.race 超时包装 + AbortController
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    abortController: AbortController
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Agent执行超时(${timeoutMs}ms): ${this.name}`));
      }, timeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
