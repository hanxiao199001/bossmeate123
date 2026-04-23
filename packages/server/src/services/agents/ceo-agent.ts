/**
 * CEO Agent - 总指挥
 *
 * 替代 Orchestrator 的调度职责，通过 EventBus 事件驱动各 Agent 协作。
 * 第一版使用规则引擎（if/else + 配置），不接 LLM。
 *
 * 核心职责:
 * 1. 每日任务触发（定时/手动 → 发布 daily.plan.start）
 * 2. 任务分发（拆解为各团队事件）
 * 3. 状态监控（订阅所有事件，维护状态表）
 * 4. 异常处理（监听 agent.error / agent.timeout，决策重试或跳过）
 * 5. 结果汇总（每日任务完成后生成报告）
 */

import { nanoid } from "nanoid";
import { db } from "../../models/db.js";
import { dailyContentPlans, tenants } from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { agentRegistry } from "./base/registry.js";
import { eventBus } from "../event-bus/index.js";
import { BaseAgent, type BaseAgentContext } from "./base/base-agent.js";
import type { AgentResult, AgentTask } from "./base/types.js";
import type { BaseAgentTaskResult } from "./base/base-agent.js";
import type { BusEvent } from "../event-bus/types.js";

/** Agent 执行状态追踪 */
interface AgentTracker {
  agentName: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout";
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/** 每日执行状态 */
interface DailyRunState {
  correlationId: string;
  tenantId: string;
  date: string;
  agents: Map<string, AgentTracker>;
  startedAt: number;
}

export class CeoAgent extends BaseAgent {
  readonly name = "ceo-agent";
  readonly displayName = "CEO Agent";

  /** 当前执行状态（每个租户一个） */
  private activeRuns = new Map<string, DailyRunState>();

  protected override async onInitialize(): Promise<void> {
    // 订阅 Agent 状态事件
    await eventBus.subscribe("agent.error", async (event: BusEvent) => {
      await this.handleAgentError(event);
    }, { group: "ceo-agent" });

    await eventBus.subscribe("agent.timeout", async (event: BusEvent) => {
      await this.handleAgentTimeout(event);
    }, { group: "ceo-agent" });

    // 订阅关键业务事件，更新状态
    await eventBus.subscribe("keyword.analyzed", async (event: BusEvent) => {
      this.updateTracker(event.correlationId, "keyword-analyzer", "completed");
    }, { group: "ceo-agent" });

    await eventBus.subscribe("content.created", async (event: BusEvent) => {
      this.updateTracker(event.correlationId, "content-director", "completed");
    }, { group: "ceo-agent" });

    await eventBus.subscribe("content.published", async (event: BusEvent) => {
      this.updateTracker(event.correlationId, "publish-manager", "completed");
    }, { group: "ceo-agent" });

    this.log("info", "事件订阅已注册");
  }

  /**
   * 每日执行主逻辑
   */
  protected async onExecute(
    context: BaseAgentContext,
    signal: AbortSignal
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const { tenantId, date, correlationId } = context;

    // 初始化执行状态
    const run: DailyRunState = {
      correlationId,
      tenantId,
      date,
      agents: new Map([
        ["knowledge-engine", { agentName: "knowledge-engine", status: "pending" }],
        ["content-director", { agentName: "content-director", status: "pending" }],
      ]),
      startedAt: startTime,
    };
    this.activeRuns.set(tenantId, run);

    const details: unknown[] = [];
    let tasksCompleted = 0;
    let tasksFailed = 0;

    // Step 1: 发布每日计划启动事件
    await this.publishEvent("daily.plan.start", tenantId, correlationId, {
      date,
      triggeredBy: context.triggeredBy,
    });
    this.log("info", "每日计划已启动", { date, correlationId });

    // Step 2: 调用 KnowledgeEngine
    if (!signal.aborted) {
      this.updateTracker(correlationId, "knowledge-engine", "running");
      const ke = agentRegistry.get("knowledge-engine");
      if (ke) {
        try {
          const keResult = await ke.execute({
            ...context,
            correlationId,
          } as any);
          if (keResult.success) {
            tasksCompleted++;
            this.updateTracker(correlationId, "knowledge-engine", "completed");
          } else {
            tasksFailed++;
            this.updateTracker(correlationId, "knowledge-engine", "failed");
          }
          details.push({ step: "knowledge-engine", success: keResult.success, summary: keResult.summary });
        } catch (err: any) {
          tasksFailed++;
          this.updateTracker(correlationId, "knowledge-engine", "failed");
          details.push({ step: "knowledge-engine", error: err.message });
          this.log("warn", "KnowledgeEngine 执行失败，继续下一步", { error: err.message });
        }
      }
    }

    // Step 3: 调用 ContentDirector
    if (!signal.aborted) {
      this.updateTracker(correlationId, "content-director", "running");
      const cd = agentRegistry.get("content-director");
      if (cd) {
        try {
          const cdResult = await cd.execute({
            ...context,
            correlationId,
          } as any);
          if (cdResult.success) {
            tasksCompleted++;
            this.updateTracker(correlationId, "content-director", "completed");
          } else {
            tasksFailed++;
            this.updateTracker(correlationId, "content-director", "failed");
          }
          details.push({ step: "content-director", success: cdResult.success, summary: cdResult.summary });
        } catch (err: any) {
          tasksFailed++;
          this.updateTracker(correlationId, "content-director", "failed");
          details.push({ step: "content-director", error: err.message });
          this.log("warn", "ContentDirector 执行失败，继续下一步", { error: err.message });
        }
      }
    }

    // Step 4: 读取今日计划
    if (!signal.aborted) {
      const [plan] = await db
        .select()
        .from(dailyContentPlans)
        .where(
          and(
            eq(dailyContentPlans.tenantId, tenantId),
            eq(dailyContentPlans.date, date)
          )
        )
        .limit(1);

      if (!plan) {
        this.log("warn", "未找到今日内容计划", { date });
        details.push({ step: "read-plan", found: false });
      } else {
        // 更新计划状态为执行中
        await db
          .update(dailyContentPlans)
          .set({ status: "executing", updatedAt: new Date() })
          .where(eq(dailyContentPlans.id, plan.id));

        const tasks = (plan.tasks || []) as any[];
        const articleCount = tasks.filter((t: any) => t.type === "article").length;

        details.push({
          step: "read-plan",
          found: true,
          planId: plan.id,
          articleCount,
        });
        tasksCompleted++;
        this.log("info", "计划已读取", { planId: plan.id, articleCount });
      }
    }

    // 清理执行状态
    this.activeRuns.delete(tenantId);

    const durationMs = Date.now() - startTime;
    return {
      agentName: this.name,
      success: tasksFailed === 0,
      tasksCompleted,
      tasksFailed,
      summary: `CEO Agent: ${tasksCompleted} 步完成, ${tasksFailed} 步失败`,
      details,
      durationMs,
    };
  }

  protected async onHandleTask(task: AgentTask): Promise<BaseAgentTaskResult> {
    const tenantId = task.input.tenantId as string;
    const result = await this.execute({
      tenantId,
      date: new Date().toISOString().slice(0, 10),
      triggeredBy: "manual",
      runId: task.id,
    });

    return {
      taskId: task.id,
      success: result.success,
      output: result,
      metrics: { durationMs: result.durationMs, tokensUsed: 0 },
    };
  }

  // --- 事件处理 ---

  private async handleAgentError(event: BusEvent): Promise<void> {
    const payload = event.payload as { agentName: string; error: string };
    this.updateTracker(event.correlationId, payload.agentName, "failed");
    this.log("warn", `Agent 错误: ${payload.agentName}`, {
      error: payload.error,
      correlationId: event.correlationId,
    });
    // 第一版：仅记录，不自动重试
  }

  private async handleAgentTimeout(event: BusEvent): Promise<void> {
    const payload = event.payload as { agentName: string; durationMs: number };
    this.updateTracker(event.correlationId, payload.agentName, "timeout");
    this.log("warn", `Agent 超时: ${payload.agentName}`, {
      durationMs: payload.durationMs,
      correlationId: event.correlationId,
    });
    // 第一版：仅记录，不自动重试
  }

  // --- 状态追踪 ---

  private updateTracker(
    correlationId: string,
    agentName: string,
    status: AgentTracker["status"]
  ): void {
    for (const run of this.activeRuns.values()) {
      if (run.correlationId === correlationId) {
        const tracker = run.agents.get(agentName);
        if (tracker) {
          tracker.status = status;
          if (status === "running") tracker.startedAt = Date.now();
          if (["completed", "failed", "timeout"].includes(status)) {
            tracker.completedAt = Date.now();
          }
        }
        break;
      }
    }
  }

  /**
   * 获取当前执行状态（供前端监控面板使用）
   */
  getActiveRuns(): Record<string, unknown>[] {
    const runs: Record<string, unknown>[] = [];
    for (const [tenantId, run] of this.activeRuns) {
      runs.push({
        tenantId,
        correlationId: run.correlationId,
        date: run.date,
        startedAt: new Date(run.startedAt).toISOString(),
        agents: Object.fromEntries(
          Array.from(run.agents.entries()).map(([k, v]) => [k, { ...v }])
        ),
      });
    }
    return runs;
  }
}
