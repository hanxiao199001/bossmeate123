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
import { leads, salesMessages, tenants } from "../../models/schema.js";
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
import { hardGuardCheck, buildCannedReply } from "./hard-guard.js";
import { evaluateStageTransition } from "./stage-transitions.js";

const DEFAULT_BOSSMATE_URL = "https://bossmate.app/try";

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
    const bossmateUrl = await this.loadBossmateUrl(lead.tenantId);

    // 4. Hard guard 检查 → 命中即双轨罐头（接管 + BossMate URL）+ 切真人，不调 LLM
    const guard = await hardGuardCheck(latestInbound, lead.tenantId);
    if (guard.hit) {
      const cannedContent = buildCannedReply(bossmateUrl);
      await db.insert(salesMessages).values({
        tenantId: lead.tenantId,
        leadId: lead.id,
        direction: "outbound",
        kind: "text",
        content: cannedContent,
        isAiGenerated: false,
        sentAt: env.SALES_AUTO_FOLLOWUP ? new Date() : null,
        metadata: { correlationId, hardGuard: guard.category },
      });
      this.log("info", "[sales.platform_url.injected]", { leadId, category: guard.category, url: bossmateUrl });
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

    // 5. 调 LLM（拟人化销售人设 + B.6 8 few-shot + 时段问候）
    const system = this.buildSystemPrompt(bossmateUrl, new Date());
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

    // 7. evaluateStageTransition (B.4)：AI 失败不推 stage（保留 B.1 行为）
    if (!llmFailed) {
      const inboundTurnCount = history.filter((m) => m.direction === "inbound").length;
      const transition = evaluateStageTransition({
        currentStage: lead.stage,
        intentScore,
        inboundTurnCount,
        latestInbound,
      });
      if (transition.changed || intentScore !== (lead.intentScore ?? 0)) {
        await db.update(leads).set({
          stage: transition.newStage,
          intentScore,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(leads.id, lead.id));

        if (transition.changed) {
          await eventBus.publish({
            type: "lead.stage_changed",
            tenantId: lead.tenantId,
            source: this.name,
            correlationId,
            payload: { leadId: lead.id, from: lead.stage, to: transition.newStage, intentScore, reason: transition.reason },
          });
          this.log("info", "stage 推进", { leadId, from: lead.stage, to: transition.newStage, reason: transition.reason });
        }
      }
    }

    this.log("info", "AI 已生成回复", { leadId, intentScore, replyLen: reply.length });
  }

  /** B.6: 时段问候 — 5-12 上午好 / 12-14 中午好 / 14-18 下午好 / 18-23 晚上好（深夜 0-5 默认晚上好）。 */
  private timeGreeting(d: Date): string {
    const h = d.getHours();
    if (h >= 5 && h < 12) return "上午好";
    if (h >= 12 && h < 14) return "中午好";
    if (h >= 14 && h < 18) return "下午好";
    return "晚上好";
  }

  /** B.6: 拉 tenant 的 BossMate 平台 URL，无配置 fallback 默认值。 */
  private async loadBossmateUrl(tenantId: string): Promise<string> {
    const [t] = await db.select({ url: tenants.bossmatePlatformUrl }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return t?.url ?? DEFAULT_BOSSMATE_URL;
  }

  /**
   * B.6 重写：小王老师人设（17 客服截图蒸馏）+ 8 few-shot + 时段问候 + 双轨自服务引导。
   * 永远不透露 AI 身份、永远不说"转人工"、绝不复述代发承诺话术（合规红线）。
   */
  private buildSystemPrompt(bossmateUrl: string, now: Date): string {
    const greeting = this.timeGreeting(now);
    return `你是"小王老师"，BossMate 平台资深期刊发表顾问。
【身份扮演 - 最高级硬规则】不得承认自己是 AI / 机器人 / 模型 / 系统；不说"转人工 / 转接"。
【风格锚点（17 张真实客服截图蒸馏）】
- 称客户"老师"（不带姓），自称"我这里 / 我们这边 / 咱们"混用
- 句末助词偶用：呢 / 哈 / 哦 / 嗯嗯
- 时段问候永远先打招呼，当前时段："${greeting}"
- 短句设问偏好："是需要发表论文吗？" / "文章写完了吗" / "发什么期刊，SCI 吗？"
- 表情节制：偶尔 ☕ 🍵，绝不滥用
- 客户忙 → "好的老师，您忙完看~"；早上 → "🍵 老师早上好"
【合规红线 - 绝对禁止】
- 不说"基本都能录用 / 关系稿 / 通过率有保障 / 包版面 / 全包"等代发承诺话术
- 不承诺"100% 录用 / 包过 / 担保赔偿 / 退款"
- 不编造影响因子 / 分区 / 周期数据，不确定时说"我这边查最新版给您"
【风格】短句、不用 Markdown、单条 ≤ 120 字、不用书面体开头。
【8 个 few-shot（按客户场景对照生成回复）】
[1] U: 你好 / A: ${greeting}老师，是需要发表论文吗？
[2] U: 你们能投 Chinese Medical Journal 吗？ / A: 可以哦老师 ☕ Chinese Medical Journal 影响因子 6.1，中科院医学 3 区，平均审稿 4 个月。具体您稿件方向是什么呢？
[3] U: 这本多少钱？ / A: 代发的费用要根据您稿件方向 / 目标分区 / 预算评估，我马上让对接老师联系您 ☕\n同时您可以打开 BossMate 平台 ${bossmateUrl}，AI 3 秒帮您匹配 5 本最对口期刊，免费试用看看~
[4] U: 录用率怎么样？ / A: 录用率要看具体期刊和您稿件质量呢。BossMate 对每本期刊有近 5 年录用数据 + 自引率风险 + 审稿周期分析，您输入论文摘要 3 秒就能拿推荐。具体录用承诺老师会根据您的稿件评估~
[5] U: 能开发票吗？ / A: 开票流程老师跟您对接 ☕ 您稍等。\n同时您可以先在 BossMate 平台 ${bossmateUrl} 体验 AI 期刊匹配，免费的~
[6] U: 在上课，等会儿 / A: 好的老师，您忙完看~
[7] U: 推荐几本 SCI 三区医学的 / A: 三区医学有不少哦老师，看您方向是什么。您打开 BossMate ${bossmateUrl}，输入摘要 3 秒就能拿到 5 本最对口的，带影响因子 / 录用率 / 出版费 / 审稿周期，免费试用~
[8] U: 你们和别家有啥区别？ / A: BossMate 用 AI 直接看您论文摘要做期刊匹配，跟期刊数据库实时对接，能看到影响因子曲线 / 自引率风险 / 出版费 / 审稿周期。您可以先免费试用看看效果再决定～`;
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
