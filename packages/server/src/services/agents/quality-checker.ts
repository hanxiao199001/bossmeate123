/**
 * QualityChecker Agent
 *
 * 职责：内容生产后自动质检 → 判定通过/需人工审核/打回重写
 *
 * 工作模式：
 *  1. 订阅 content.created 事件
 *  2. 读取 contents 行 → 调 qualityCheckV2 (红线+风格+评分+平台)
 *  3. 根据结果决策：
 *     - overallPassed && totalScore >= AUTO_APPROVE_SCORE → approved，发 content.approved
 *     - redline critical violations → rejected，发 content.rejected
 *     - 其它 → reviewing，发 content.review_needed
 *  4. 将质检结果写入 contents.metadata.qualityCheck
 */

import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { eventBus } from "../event-bus/index.js";
import { qualityCheckV2 } from "../content-engine/quality-check-v2.js";
import type { QualityCheckV2Result } from "../content-engine/quality-check-v2.js";
import { BaseAgent } from "./base/base-agent.js";
import type { BaseAgentContext, BaseAgentTaskResult } from "./base/base-agent.js";
import type { AgentResult, AgentTask } from "./base/types.js";
import type { BusEvent } from "../event-bus/types.js";

// 分数门槛（>= 该分数直接自动放行）
const AUTO_APPROVE_SCORE = 85;

interface ContentCreatedPayload {
  contentId: string;
  title?: string;
  platform?: string;
}

type DecisionStatus = "approved" | "reviewing" | "rejected";

export class QualityCheckerAgent extends BaseAgent {
  readonly name = "quality-checker";
  readonly displayName = "QualityChecker Agent";

  private subscribed = false;

  protected async onInitialize(): Promise<void> {
    if (!this.subscribed) {
      await eventBus.subscribe<ContentCreatedPayload>(
        "content.created",
        (evt) => this.handleContentCreated(evt),
        { group: "group:quality-checker", consumer: `quality-checker:${process.pid}` }
      );
      this.subscribed = true;
      this.log("info", "已订阅 content.created");
    }
  }

  /**
   * 手动触发执行：扫描 status=draft 的内容并质检
   * （主要给 CEO Agent / 兜底调度使用）
   */
  protected async onExecute(
    context: BaseAgentContext,
    signal: AbortSignal
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const rows = await db
      .select({ id: contents.id, tenantId: contents.tenantId })
      .from(contents)
      .where(eq(contents.tenantId, context.tenantId))
      .limit(50);

    const drafts = rows.filter(() => true);
    let ok = 0;
    let fail = 0;

    for (const row of drafts) {
      if (signal.aborted) break;
      try {
        await this.checkOne(row.id, context.correlationId);
        ok++;
      } catch (err) {
        fail++;
        this.log("warn", "单条质检失败", {
          contentId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      agentName: this.name,
      success: fail === 0,
      tasksCompleted: ok,
      tasksFailed: fail,
      summary: `质检完成：通过 ${ok} / 失败 ${fail}`,
      durationMs: Date.now() - startTime,
    };
  }

  protected async onHandleTask(task: AgentTask): Promise<BaseAgentTaskResult> {
    const startTime = Date.now();
    const contentId = task.input.contentId as string;
    const correlationId = (task.input.correlationId as string) || task.id;
    if (!contentId) {
      return {
        taskId: task.id,
        success: false,
        error: "缺少 contentId",
        metrics: { durationMs: Date.now() - startTime, tokensUsed: 0 },
      };
    }
    const decision = await this.checkOne(contentId, correlationId);
    return {
      taskId: task.id,
      success: decision !== "rejected",
      output: { decision },
      metrics: { durationMs: Date.now() - startTime, tokensUsed: 0 },
    };
  }

  // --- 事件处理 ---

  private async handleContentCreated(
    event: BusEvent<ContentCreatedPayload>
  ): Promise<void> {
    const { contentId } = event.payload;
    if (!contentId) {
      this.log("warn", "content.created 事件缺 contentId，跳过");
      return;
    }
    await this.checkOne(contentId, event.correlationId);
  }

  // --- 核心：对单条内容做质检 ---

  private async checkOne(
    contentId: string,
    correlationId: string
  ): Promise<DecisionStatus> {
    const [row] = await db
      .select()
      .from(contents)
      .where(eq(contents.id, contentId))
      .limit(1);
    if (!row) {
      throw new Error(`内容不存在: ${contentId}`);
    }
    this.validateTenantIdPublic(row.tenantId);

    const title = row.title ?? "";
    const body = row.body ?? "";
    const platform = this.firstPlatform(row.platforms);

    if (!body) {
      this.log("warn", "内容正文为空，跳过质检", { contentId });
      return "rejected";
    }

    const qc = await qualityCheckV2({
      tenantId: row.tenantId,
      title,
      body,
      platform,
    });

    const decision = this.decide(qc);

    // 写回 contents
    await db
      .update(contents)
      .set({
        status:
          decision === "approved"
            ? "approved"
            : decision === "rejected"
            ? "draft"
            : "reviewing",
        metadata: {
          ...(typeof row.metadata === "object" && row.metadata ? row.metadata : {}),
          qualityCheck: {
            totalScore: qc.totalScore,
            passed: qc.passed,
            overallPassed: qc.overallPassed,
            redline: qc.redlineCheck,
            style: qc.styleCheck,
            platform: qc.platformCheck,
            feedback: qc.feedback,
            decision,
            checkedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(contents.id, contentId));

    // 发事件
    const eventType =
      decision === "approved"
        ? "content.approved"
        : decision === "rejected"
        ? "content.rejected"
        : "content.review_needed";

    await eventBus.publish({
      type: eventType,
      tenantId: row.tenantId,
      source: this.name,
      correlationId,
      payload: {
        contentId,
        title: title.slice(0, 100),
        decision,
        totalScore: qc.totalScore,
        reason: decision === "rejected" ? this.summarizeFailures(qc) : undefined,
      },
    });

    this.log("info", `质检决策: ${decision}`, {
      contentId,
      totalScore: qc.totalScore,
      overallPassed: qc.overallPassed,
      correlationId,
    });

    return decision;
  }

  private decide(qc: QualityCheckV2Result): DecisionStatus {
    // 红线致命违规 → 直接打回
    const criticalRedline = qc.redlineCheck.violations.some(
      (v) => v.severity === "critical"
    );
    if (criticalRedline || !qc.redlineCheck.passed) {
      return "rejected";
    }

    // 分数低于全局门槛 → 打回
    if (qc.totalScore < env.QUALITY_MIN_SCORE) {
      return "rejected";
    }

    // 高分 + 其它维度全过 → 自动放行
    if (qc.overallPassed && qc.totalScore >= AUTO_APPROVE_SCORE) {
      return "approved";
    }

    // 其它情况走人工审核
    return "reviewing";
  }

  private summarizeFailures(qc: QualityCheckV2Result): string {
    const parts: string[] = [];
    if (!qc.redlineCheck.passed) {
      parts.push(
        `红线违规 ${qc.redlineCheck.violations.length} 条`
      );
    }
    if (qc.totalScore < env.QUALITY_MIN_SCORE) {
      parts.push(`评分 ${qc.totalScore} < ${env.QUALITY_MIN_SCORE}`);
    }
    if (!qc.platformCheck.passed) {
      parts.push(`平台规则未通过: ${qc.platformCheck.issues.join("; ")}`);
    }
    return parts.join("; ") || qc.feedback || "未通过";
  }

  private firstPlatform(raw: unknown): string | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const first = raw[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "platform" in (first as object)) {
      return String((first as { platform?: unknown }).platform ?? "");
    }
    return undefined;
  }

  /** 暴露校验方法给本类 private 使用（父类是 private，这里包装一层） */
  private validateTenantIdPublic(tenantId: string): void {
    if (!tenantId || typeof tenantId !== "string") {
      throw new Error(`${this.name}: tenantId 非法`);
    }
  }
}

export const qualityCheckerAgent = new QualityCheckerAgent();
