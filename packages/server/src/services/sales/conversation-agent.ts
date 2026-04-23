/**
 * ConversationAgent (AI 销售对话 - 拟人化无缝模式)
 *
 * 设计原则：
 *   - AI 全程以"真人销售"的人设与客户沟通，**永远不向客户透露自己是 AI / 会转人工**。
 *   - 无论是否命中静默转人工规则，AI 都会照常生成回复、写入 sales_messages
 *     （保持客户感知的连续性）。
 *   - 静默转人工通过 `lead.need_human` 事件通知后台（企微群 / 销售工位），
 *     真人接管后在同一对话框继续回复，客户感知不到切换。
 *
 * 流程：lead.collected → 调 LLM 生成拟人化回复 → 写 sales_messages (outbound)
 *      → 评分 / stage 推进 → 并行评估静默转人工规则 → 发 lead.stage_changed
 *        和（按需）lead.need_human
 */

import { and, eq, desc } from "drizzle-orm";
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

interface LeadCollectedPayload {
  leadId: string;
  isNew: boolean;
  channel: string;
  messageId: string;
  content: string;
  sourceContentId?: string;
}

/** 静默转人工：风险词（投诉/纠纷/监管） */
const RISK_KEYWORDS = [
  "投诉",
  "举报",
  "曝光",
  "律师",
  "起诉",
  "诉讼",
  "12315",
  "消协",
  "315",
  "退款",
  "维权",
  "骗子",
  "退钱",
];

/** 静默转人工：成交临门一脚词（需要真人敲定合同 / 收款） */
const DEAL_KEYWORDS = [
  "签合同",
  "打款",
  "付款",
  "转账",
  "付定金",
  "付全款",
  "发票",
  "对公",
  "合同",
];

/** 客户直接质疑身份（AI 照常拟人化回答，后台静默通知） */
const IDENTITY_PROBE_KEYWORDS = [
  "机器人",
  "ai",
  "AI",
  "人工智能",
  "是真人吗",
  "是不是人",
  "你是不是真",
  "你是人吗",
];

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

    // 2. 取最近对话历史（也用于判定对话轮数，用于静默转人工的规则 4）
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

    const inboundTurnCount = history.filter((m) => m.direction === "inbound").length;

    // 3. 调 LLM（无论是否要静默转人工，都照常回复，保持拟人化连续性）
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
      // 拟人化兜底：不提"AI"、"系统"；像忙碌销售随口一句的语气
      reply = "稍等我确认一下，很快回复您～";
    }

    if (!reply) {
      reply = "您好～请问您这边是哪个方向的稿件、希望投什么级别的期刊呀？";
    }

    // 4. 写回消息（客户看到的始终是统一销售身份）
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

    // 5. 评分 & stage 推进
    const intentScore = this.estimateIntent(latestInbound, messages.length);
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
          payload: {
            leadId: lead.id,
            from: lead.stage,
            to: newStage,
            intentScore,
          },
        });
      }
    }

    // 6. 静默转人工规则评估（不影响客户侧的 AI 回复）
    await this.evaluateSilentHandoff({
      lead,
      latestInbound,
      inboundTurnCount,
      intentScore,
      llmFailed,
      correlationId,
    });

    this.log("info", "AI 已生成回复", {
      leadId,
      stage: newStage,
      intentScore,
      replyLen: reply.length,
    });
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

  /**
   * 静默转人工规则评估。
   * 任何一条命中都会发 lead.need_human 事件（后台接收方：企微群机器人 / 销售工位推送 / 后台弹窗）。
   * 注意：本方法**不**停止 AI 回复、**不**改变 stage，AI 侧对客户继续拟人化沟通。
   */
  private async evaluateSilentHandoff(args: {
    lead: typeof leads.$inferSelect;
    latestInbound: string;
    inboundTurnCount: number;
    intentScore: number;
    llmFailed: boolean;
    correlationId: string;
  }): Promise<void> {
    const { lead, latestInbound, inboundTurnCount, intentScore, llmFailed, correlationId } = args;
    const reasons: string[] = [];
    let priority: "high" | "medium" = "medium";

    // 规则 1：风险词（投诉 / 维权 / 法律）→ 高优先级，立即通知
    if (RISK_KEYWORDS.some((k) => latestInbound.includes(k))) {
      reasons.push("risk_keyword");
      priority = "high";
    }

    // 规则 2：成交词（合同 / 打款 / 发票）→ 高优先级，真人接手敲定
    if (DEAL_KEYWORDS.some((k) => latestInbound.includes(k))) {
      reasons.push("deal_stage_keyword");
      priority = "high";
    }

    // 规则 3：客户质疑身份（AI 照常拟人化应答，仅后台提醒值班同事关注）
    const lower = latestInbound.toLowerCase();
    if (IDENTITY_PROBE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      reasons.push("identity_probe");
    }

    // 规则 4：高意向（意向分够高且对价格/周期/付款有明确追问）→ 高优先级抢单
    const pricingWords = ["多少钱", "价格", "报价", "费用", "几天", "周期", "多久", "付款"];
    if (intentScore >= 80 && pricingWords.some((k) => latestInbound.includes(k))) {
      reasons.push("high_intent_pricing");
      priority = "high";
    }

    // 规则 5：对话轮数过多但仍未推进（≥ 6 轮且 stage 仍为 contacted）→ 中优先级兜底
    if (inboundTurnCount >= 6 && (lead.stage === "contacted" || lead.stage === "new")) {
      reasons.push("stalled_conversation");
    }

    // 规则 6：AI 本轮失败 → 真人尽快接手，避免客户感知异常
    if (llmFailed) {
      reasons.push("ai_failure");
    }

    if (reasons.length === 0) return;

    await eventBus.publish({
      type: "lead.need_human",
      tenantId: lead.tenantId,
      source: this.name,
      correlationId,
      payload: {
        leadId: lead.id,
        reasons,
        priority,
        intentScore,
        stage: lead.stage,
        latestInbound,
      },
    });

    this.log("info", "静默转人工通知已发出", {
      leadId: lead.id,
      reasons,
      priority,
    });
  }

  /** 极简意向评分：长度 + 关键词 + 对话轮数 */
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
