/**
 * PublishManager Agent
 *
 * 职责：订阅 content.approved → 调 publishToAccounts → 发 content.published
 *
 * 策略：
 *  - 对该 tenant 下所有 active 的平台账号一键分发（V1 策略）
 *  - 可通过 metadata.publishAccountIds 显式限定目标账号
 *  - 发布成功 → 发 content.published { platform, accountId, url }
 *  - 任一平台失败不阻塞其它 → 失败计入 agentLogs，并发 agent.error
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, platformAccounts } from "../../models/schema.js";
import { eventBus } from "../event-bus/index.js";
import { publishToAccounts } from "../publisher/index.js";
import { BaseAgent } from "./base/base-agent.js";
import type {
  BaseAgentContext,
  BaseAgentTaskResult,
} from "./base/base-agent.js";
import type { AgentResult, AgentTask } from "./base/types.js";
import type { BusEvent } from "../event-bus/types.js";

interface ContentApprovedPayload {
  contentId: string;
  title?: string;
}

export class PublishManagerAgent extends BaseAgent {
  readonly name = "publish-manager";
  readonly displayName = "PublishManager Agent";

  private subscribed = false;

  protected async onInitialize(): Promise<void> {
    if (!this.subscribed) {
      await eventBus.subscribe<ContentApprovedPayload>(
        "content.approved",
        (evt) => this.handleApproved(evt),
        {
          group: "group:publish-manager",
          consumer: `publish-manager:${process.pid}`,
        }
      );
      this.subscribed = true;
      this.log("info", "已订阅 content.approved");
    }
  }

  protected async onExecute(
    context: BaseAgentContext,
    _signal: AbortSignal
  ): Promise<AgentResult> {
    // 手动触发：扫描 status=approved 的内容重跑分发
    const startTime = Date.now();
    const rows = await db
      .select({ id: contents.id })
      .from(contents)
      .where(
        and(
          eq(contents.tenantId, context.tenantId),
          eq(contents.status, "approved")
        )
      )
      .limit(50);

    let ok = 0;
    let fail = 0;
    for (const r of rows) {
      try {
        await this.dispatchOne(context.tenantId, r.id, context.correlationId);
        ok++;
      } catch (err) {
        fail++;
        this.log("warn", "分发失败", {
          contentId: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      agentName: this.name,
      success: fail === 0,
      tasksCompleted: ok,
      tasksFailed: fail,
      summary: `分发完成：${ok}/${ok + fail}`,
      durationMs: Date.now() - startTime,
    };
  }

  protected async onHandleTask(task: AgentTask): Promise<BaseAgentTaskResult> {
    const startTime = Date.now();
    const tenantId = task.input.tenantId as string;
    const contentId = task.input.contentId as string;
    const correlationId = (task.input.correlationId as string) || task.id;
    if (!tenantId || !contentId) {
      return {
        taskId: task.id,
        success: false,
        error: "缺少 tenantId 或 contentId",
        metrics: { durationMs: Date.now() - startTime, tokensUsed: 0 },
      };
    }
    const results = await this.dispatchOne(tenantId, contentId, correlationId);
    return {
      taskId: task.id,
      success: results.every((r) => r.success),
      output: results,
      metrics: { durationMs: Date.now() - startTime, tokensUsed: 0 },
    };
  }

  // --- core ---

  private async handleApproved(
    event: BusEvent<ContentApprovedPayload>
  ): Promise<void> {
    await this.dispatchOne(
      event.tenantId,
      event.payload.contentId,
      event.correlationId
    );
  }

  private async dispatchOne(
    tenantId: string,
    contentId: string,
    correlationId: string
  ) {
    // 取 tenant 下所有 active 账号
    const accounts = await db
      .select({ id: platformAccounts.id, platform: platformAccounts.platform })
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.tenantId, tenantId),
          eq(platformAccounts.status, "active")
        )
      );

    if (accounts.length === 0) {
      this.log("warn", "无可用平台账号，跳过发布", { tenantId, contentId });
      return [];
    }

    const results = await publishToAccounts({
      tenantId,
      contentId,
      accountIds: accounts.map((a) => a.id),
    });

    // 发事件：逐账号成功各发一条 content.published；失败发 agent.error
    for (const r of results) {
      if (r.success) {
        await eventBus.publish({
          type: "content.published",
          tenantId,
          source: this.name,
          correlationId,
          payload: {
            contentId,
            platform: r.platform,
            accountId: r.accountId,
            accountName: r.accountName,
            url: r.url,
            publishId: r.publishId,
          },
        });
      } else {
        await eventBus.publish({
          type: "agent.error",
          tenantId,
          source: this.name,
          correlationId,
          payload: {
            agentName: this.name,
            step: "publish",
            contentId,
            platform: r.platform,
            accountId: r.accountId,
            error: r.error,
          },
        });
      }
    }

    this.log("info", "分发完成", {
      contentId,
      total: results.length,
      ok: results.filter((r) => r.success).length,
    });

    return results;
  }
}

export const publishManagerAgent = new PublishManagerAgent();
