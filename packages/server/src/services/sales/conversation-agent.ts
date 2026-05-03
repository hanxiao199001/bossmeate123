/**
 * ConversationAgent (AI 销售对话 - 拟人化模式 + B.3 hard guard)
 *
 * B.3 重写后流程：
 *   ingest → estimateIntent → hardGuardCheck →
 *     命中 → 罐头消息 + handoverMode='human' + stage='need_human' + lead.need_human → return（不调 LLM）
 *     未命中 → LLM 拟人化回复 → 写 sales_messages → stage 推进
 *
 * Hard guard 4 类（quote / contract / legal / deadline）= 高风险词，AI 不应自行回应。
 * Whitelist 命中 = 视为已澄清场景，正常走 LLM。
 * AI 失败兜底语保留，不推 stage（保留 B.1 行为）。
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../models/db.js";
import { leads, salesMessages } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { eventBus } from "../event-bus/index.js";
import { chat } from "../ai/chat-service.js";
import { rateLimiter } from "../rate-limiter/index.js";
import { BaseAgent } from "../agents/base/base-agent.js";
import type {
  BaseAgentContext,
  BaseAgentTaskResult,
} from "../agents/base/base-agent.js";
import type { AgentResult, AgentTask } from "../agents/base/types.js";
import type { BusEvent } from "../event-bus/types.js";
import { hardGuardCheck, CANNED_REPLY } from "./hard-guard.js";

interface LeadCollectedPayload {
  leadId: string;
  isNew: boolean;
  channel: string;
  messageId: string;
  content: string;
  sourceContentId?: string;
}

export class ConversationAgent extends BaseAgent {
  readonly name = "conversation-agent";
  readonly displayName = "AI 销售对话 Agent";

  private subscribed = false;

  protected async onInitialize(): Promise<void> {
    if (!this.subscribed) {
      await eventBus.subscribe<LeadCollectedPayload>(
        "lead.collected",
        (evt) => this.handle(evt),
        {
          group: "group:conversation-agent",
          consumer: `conversation-agent:${process.pid}`,
        }
      );
      this.subscribed = true;
      this.log("info", "已订阅 lead.collected");
    }
  }

  protected async onExecute(
    _context: BaseAgentContext,
    _signal: AbortSignal
  ): Promise<AgentResult> {
    // 主动扫描当前无回复的 new / contacted leads 进行跟进（可选；此处简化返回）
    return {
      agentName: this.name,
      success: true,
      tasksCompleted: 0,
      tasksFailed: 0,
      summary: "ConversationAgent 被动模式运行（订阅驱动）",
      durationMs: 0,
    };
  }

  protected async onHandleTask(task: AgentTask): Promise<BaseAgentTaskResult> {
    const leadId = task.input.leadId as string;
    const content = task.input.content as string;
    const correlationId = (task.input.correlationId as string) || task.id;
    if (!leadId || !content) {
      return {
        taskId: task.id,
        success: false,
        error: "缺少 leadId 或 content",
      };
    }
    const out = await this.respondToLead(leadId, content, correlationId);
    return {
      taskId: task.id,
      success: true,
      output: out,
    };
  }

  // --- core ---

  private async handle(event: BusEvent<LeadCollectedPayload>): Promise<void> {
    const { leadId, content } = event.payload;
    await this.respondToLead(leadId, content, event.correlationId);
  }

  private async respondToLead(
    leadId: string,
    latestInbound: string,
    correlationId: string
  ) {
    // 1. 取 lead
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      this.log("warn", "lead 不存在", { leadId });
      return;
    }

    // 2. 取最近对话历史
    const history = await db
      .select()
      .from(salesMessages)
      .where(
        and(
          eq(salesMessages.tenantId, lead.tenantId),
          eq(salesMessages.leadId, lead.id)
        )
      )
      .orderBy(desc(salesMessages.createdAt))
      .limit(10);

    const messages = history
      .reverse()
      .map((m) => ({
        role: (m.direction === "inbound" ? "user" : "assistant") as
          | "user"
          | "assistant",
        content: m.content,
      }));

    // 3. estimateIntent（保留，B.4 stage 推进还要用 + need_human payload）
    const intentScore = this.estimateIntent(latestInbound, messages.length);

    // 4. Hard guard 检查 → 命中即罐头 + 切真人接管，不调 LLM
    const guard = await hardGuardCheck(latestInbound, lead.tenantId);
    if (guard.hit) {
      await db.insert(salesMessages).values({
        tenantId: lead.tenantId,
        leadId: lead.id,
        direction: "outbound",
        kind: "text",
        content: CANNED_REPLY,
        isAiGenerated: false,
        sentAt: env.SALES_AUTO_FOLLOWUP ? new Date() : null,
        metadata: { correlationId, hardGuard: guard.category },
      });
      await db
        .update(leads)
        .set({
          stage: "need_human",
          handoverMode: "human",
          intentScore,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(leads.id, lead.id));
      await eventBus.publish({
        type: "lead.need_human",
        tenantId: lead.tenantId,
        source: this.name,
        correlationId,
        payload: {
          leadId: lead.id,
          category: guard.category,
          intentScore,
          stage: "need_human",
          latestInbound,
        },
      });
      this.log("info", "hard guard 命中，已切真人接管", {
        leadId,
        category: guard.category,
      });
      return;
    }

    // 5. 调 LLM（拟人化销售人设）
    const system = this.buildSystemPrompt();
    await rateLimiter.acquireOrWait("openai");
    let reply = "";
    let llmFailed = false;
    try {
      const resp = await chat({
        tenantId: lead.tenantId,
        userId: lead.assignedUserId ?? lead.tenantId,
        conversationId: `sales-lead-${lead.id}`,
        message: latestInbound,
        skillType: "customer_service",
        systemPrompt: system,
        context: messages.slice(0, -1),
      });
      reply = resp.content?.trim() || "";
    } catch (err) {
      llmFailed = true;
      this.log("error", "LLM 调用失败", {
        leadId,
        error: err instanceof Error ? err.message : String(err),
      });
      reply = "稍等我确认一下，很快回复您～";
    }
    if (!reply) {
      reply = "您好～请问您这边是哪个方向的稿件、希望投什么级别的期刊呀？";
    }

    // 6. 写回消息
    await db.insert(salesMessages).values({
      tenantId: lead.tenantId,
      leadId: lead.id,
      direction: "outbound",
      kind: "text",
      content: reply,
      isAiGenerated: true,
      sentAt: env.SALES_AUTO_FOLLOWUP ? new Date() : null,
      metadata: { correlationId },
    });

    // 7. evaluateStageTransition：AI 失败不推 stage（保留 B.1 行为）
    if (!llmFailed) {
      let newStage = lead.stage;
      if (intentScore >= 70) newStage = "qualified";
      else if (lead.stage === "new") newStage = "contacted";

      if (newStage !== lead.stage || intentScore !== (lead.intentScore ?? 0)) {
        await db
          .update(leads)
          .set({
            stage: newStage,
            intentScore,
            lastMessageAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(leads.id, lead.id));

        if (newStage !== lead.stage) {
          await eventBus.publish({
            type: "lead.stage_changed",
            tenantId: lead.tenantId,
            source: this.name,
            correlationId,
            payload: { leadId: lead.id, from: lead.stage, to: newStage, intentScore },
          });
        }
      }
    }

    this.log("info", "AI 已生成回复", { leadId, intentScore, replyLen: reply.length });
  }

  /**
   * 拟人化销售人设 system prompt。
   * 核心硬规则：永远不透露 AI 身份、永远不说"转人工/转接"。
   */
  private buildSystemPrompt(): string {
    return `你是"小王老师"，一名在学术期刊发表领域工作 5 年的资深发表顾问，代表公司与客户沟通。
【身份扮演 - 最高级硬规则，违反即视为严重错误】
- 你就是真人顾问本人。无论客户怎么问，都不得承认自己是 AI、机器人、模型、程序、助手、客服系统。
- 禁止说出以下词：AI、人工智能、机器人、模型、自动回复、系统、智能助手、转人工、转接、转同事、转接客服。
- 若客户质疑"你是不是机器人/AI/真人"，用自然口吻化解，例如："哈哈我是小王老师本人哦，在帮 XX 老师团队对接发表的～请问您是想了解哪块？"，然后继续聊业务。
- 遇到情绪化 / 投诉 / 退款 / 纠纷类话术，不要说"已转接"，而是以真人销售的方式共情 + 承诺跟进，例如："这个情况我非常重视，我这边马上查一下您的单子详情，稍后同步给您最新进展。" —— 实际后台会静默通知真人同事接手。

【业务目标】
- 理解客户的投稿需求（学科方向、稿件状态、预算、期望期刊级别、时间节点）
- 基于需求推荐合适期刊 / 会议 / 增值服务
- 引导客户提供联系方式或进一步细节，推进到成交
- 涉及报价、合同、付款等临门一脚的动作时，用"我这边再帮您核一下最新政策"等方式自然衔接，不要自己给死报价

【风格】
- 像真人微信聊天：短句、偶尔带"～""哦""嗯嗯"；单条不超过 120 字；不要用书面体"您好，感谢您的咨询"开头。
- 专业但不端着，热情但不谄媚；必要时可承认"这个我得查一下"以显得真实。
- 不使用 Markdown 格式（不要 **粗体** 不要列表符号），就是纯文本聊天。

【硬禁止】
- 不承诺"保证录用 / 100% 过 / 包录"
- 不编造期刊影响因子、分区、审稿周期等数据；不确定时说"我这边查下最新版给您"
- 不泄露内部定价策略和返利政策`;
  }

  /** 极简意向评分：长度 + 关键词 + 对话轮数（保留供 B.4 stage 推进 + need_human payload 使用） */
  private estimateIntent(text: string, turnCount: number): number {
    let score = 30;
    if (text.length > 30) score += 10;
    if (text.length > 80) score += 10;
    const positives = ["想投", "想发", "价格", "多少钱", "周期", "多久", "推荐"];
    for (const p of positives) {
      if (text.includes(p)) score += 10;
    }
    score += Math.min(20, turnCount * 3);
    return Math.max(0, Math.min(100, score));
  }
}

export const conversationAgent = new ConversationAgent();
