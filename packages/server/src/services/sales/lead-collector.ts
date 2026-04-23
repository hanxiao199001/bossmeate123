/**
 * LeadCollector - 线索收集服务
 *
 * 从多渠道收到的"客户侧消息/评论/私信"统一入口，
 * 去重后创建 / 更新 leads 行，并生成 sales_messages 记录，
 * 最后发 lead.collected 事件让 ConversationAgent 接管回复。
 *
 * 调用入口：
 *  - 微信公众号评论 webhook
 *  - 企业微信客服消息 webhook
 *  - 小红书/知乎私信轮询器
 *  - 手动导入
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { leads, salesMessages } from "../../models/schema.js";
import { eventBus } from "../event-bus/index.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";

export interface InboundMessage {
  tenantId: string;
  channel: string;           // comment_wechat | wechat_work | zhihu_dm ...
  externalUserId: string;    // 渠道方的用户ID (去重键)
  name?: string;
  phone?: string;
  email?: string;
  content: string;
  /** 可选：客户回复的文章 */
  sourceContentId?: string;
  /** 附加信息：例如评论ID、时间戳 */
  metadata?: Record<string, unknown>;
  receivedAt?: Date;
}

export interface CollectResult {
  leadId: string;
  isNew: boolean;
  messageId: string;
}

export class LeadCollector {
  async collect(msg: InboundMessage): Promise<CollectResult> {
    const now = msg.receivedAt ?? new Date();

    // upsert lead
    const [existing] = await db
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, msg.tenantId),
          eq(leads.channel, msg.channel),
          eq(leads.externalId, msg.externalUserId)
        )
      )
      .limit(1);

    let leadId: string;
    let isNew = false;

    if (existing) {
      leadId = existing.id;
      await db
        .update(leads)
        .set({
          name: msg.name ?? existing.name,
          phone: msg.phone ?? existing.phone,
          email: msg.email ?? existing.email,
          lastMessageAt: now,
          updatedAt: now,
        })
        .where(eq(leads.id, leadId));
    } else {
      const [created] = await db
        .insert(leads)
        .values({
          tenantId: msg.tenantId,
          channel: msg.channel,
          externalId: msg.externalUserId,
          name: msg.name,
          phone: msg.phone,
          email: msg.email,
          contactId: msg.externalUserId,
          sourceContentId: msg.sourceContentId,
          stage: "new",
          intentScore: 0,
          lastMessageAt: now,
        })
        .returning({ id: leads.id });
      leadId = created.id;
      isNew = true;
    }

    // insert inbound message
    const [savedMsg] = await db
      .insert(salesMessages)
      .values({
        tenantId: msg.tenantId,
        leadId,
        direction: "inbound",
        kind: "text",
        content: msg.content,
        isAiGenerated: false,
        sentAt: now,
        metadata: msg.metadata ?? {},
      })
      .returning({ id: salesMessages.id });

    // 若该 lead 已处于真人接管模式，仅入库，不触发 AI 响应
    const isHumanMode = existing?.handoverMode === "human";

    if (isHumanMode) {
      logger.info(
        { leadId, channel: msg.channel },
        "lead 处于接管模式，已跳过 AI 响应"
      );
    } else if (!env.SALES_AGENT_ENABLED) {
      logger.info(
        { leadId, channel: msg.channel },
        "SALES_AGENT_ENABLED=false，已入库但不触发 AI 响应"
      );
    } else {
      // 发事件 → ConversationAgent 会处理
      await eventBus.publish({
        type: "lead.collected",
        tenantId: msg.tenantId,
        source: "lead-collector",
        correlationId: `lead-${leadId}-${Date.now()}`,
        payload: {
          leadId,
          isNew,
          channel: msg.channel,
          messageId: savedMsg.id,
          content: msg.content,
          sourceContentId: msg.sourceContentId,
        },
      });

      logger.info(
        { leadId, isNew, channel: msg.channel },
        "线索已收集"
      );
    }

    return { leadId, isNew, messageId: savedMsg.id };
  }
}

export const leadCollector = new LeadCollector();
