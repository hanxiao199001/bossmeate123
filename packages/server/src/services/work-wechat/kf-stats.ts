/**
 * B-kf 概览统计（kf-stats）—— 运营"客服活着没 + 哪些没答上"的数据层。
 *
 * 全部从现有 kf_conversations / kf_messages 聚合，不加新表；
 * 租户隔离：kf_messages 无 tenant_id，一律 JOIN kf_conversations 过滤（与 work-wechat-kf 路由同模式）。
 *
 * 口径（与 kf-responder 落库的 ai_action 对齐）：
 *   conversations    = 去重客户数（direction=in 的 distinct external_userid）
 *   customerMessages = 客户消息条数（direction=in）
 *   aiReplies        = AI 回复条数（direction=out & ai_action=answered）
 *   handoffs         = 转人工次数（direction=out & ai_action=transferred）
 *   manualReplies    = 人工回复条数（direction=out & ai_action in (manual, human_wecom)，系统内人工 + 企微端人工）
 *   blockedSensitive = 敏感词出站拦截次数（direction=out & ai_action=blocked_sensitive，未外发的审计记录）
 * 敏感词拦截事件会同时产生 blocked_sensitive（审计）+ transferred（兜底转接话术）两条出站记录，
 * 故 handoffs 已含拦截触发的转人工；"没答上"清单按 transferred 出，用 sensitiveBlocked 布尔标注来源，不重复列。
 * 按天分桶用 Asia/Shanghai（运营时区，与 scheduler cron 同约定）。
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { kfConversations, kfMessages, workWechatConfigs } from "../../models/schema.js";

export interface KfStatBucket {
  conversations: number;
  customerMessages: number;
  aiReplies: number;
  handoffs: number;
  manualReplies: number;
  blockedSensitive: number;
}
export interface KfDailyStat extends KfStatBucket {
  date: string; // YYYY-MM-DD（Asia/Shanghai）
}
export interface KfUnansweredItem {
  conversationId: string;
  externalUserid: string;
  /** 触发转人工前客户最后一条文本消息原文 —— 运营补 FAQ 的最直接依据 */
  question: string | null;
  transferredAt: Date | string | null;
  /** 本次转人工是否由敏感词出站拦截触发（同会话 1 分钟内有 blocked_sensitive 审计记录） */
  sensitiveBlocked: boolean;
}
export interface KfStatsResult {
  days: number;
  today: KfDailyStat;
  period: KfStatBucket;      // 近 N 天总量（去重客户数跨天 distinct，≠ daily 求和）
  daily: KfDailyStat[];      // 旧→新，无数据的天补 0（前端柱状图直接用）
  unanswered: KfUnansweredItem[];
  /** 只回"是否已配置"布尔，绝不回 Secret 本身（同 GET /work-wechat/config 安全约定） */
  agentSecretConfigured: boolean;
}

const TZ = "Asia/Shanghai";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }); // → YYYY-MM-DD

const ZERO: KfStatBucket = { conversations: 0, customerMessages: 0, aiReplies: 0, handoffs: 0, manualReplies: 0, blockedSensitive: 0 };
const DAY_MS = 86_400_000;

/** 近 N 天窗口起点：上海时区今天 0 点往前推 N-1 天（中国无夏令时，毫秒运算安全） */
function windowStart(days: number): Date {
  const todayStart = new Date(`${dayFmt.format(new Date())}T00:00:00+08:00`);
  return new Date(todayStart.getTime() - (days - 1) * DAY_MS);
}

export async function getKfStats(tenantId: string, daysRaw = 7, unansweredLimit = 20): Promise<KfStatsResult> {
  const days = Math.max(1, Math.min(30, Math.floor(daysRaw) || 7));
  const since = windowStart(days);
  const todayStr = dayFmt.format(new Date());

  // 聚合列（period 与 daily 共用，保证口径一致）
  const bucketCols = {
    conversations: sql<number>`count(distinct ${kfConversations.externalUserid}) filter (where ${kfMessages.direction} = 'in')::int`,
    customerMessages: sql<number>`count(*) filter (where ${kfMessages.direction} = 'in')::int`,
    aiReplies: sql<number>`count(*) filter (where ${kfMessages.direction} = 'out' and ${kfMessages.aiAction} = 'answered')::int`,
    handoffs: sql<number>`count(*) filter (where ${kfMessages.direction} = 'out' and ${kfMessages.aiAction} = 'transferred')::int`,
    manualReplies: sql<number>`count(*) filter (where ${kfMessages.direction} = 'out' and ${kfMessages.aiAction} in ('manual', 'human_wecom'))::int`,
    blockedSensitive: sql<number>`count(*) filter (where ${kfMessages.direction} = 'out' and ${kfMessages.aiAction} = 'blocked_sensitive')::int`,
  };
  const scope = and(eq(kfConversations.tenantId, tenantId), gte(kfMessages.createdAt, since));

  // 1) 近 N 天总量
  const [periodRow] = await db.select(bucketCols)
    .from(kfMessages)
    .innerJoin(kfConversations, eq(kfMessages.conversationId, kfConversations.id))
    .where(scope);

  // 2) 按天序列（同一 dateExpr 同时进 SELECT/GROUP BY/ORDER BY，无参数化差异）
  const dateExpr = sql<string>`to_char(${kfMessages.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`;
  const dailyRows = await db.select({ date: dateExpr, ...bucketCols })
    .from(kfMessages)
    .innerJoin(kfConversations, eq(kfMessages.conversationId, kfConversations.id))
    .where(scope)
    .groupBy(dateExpr)
    .orderBy(dateExpr);

  const byDate = new Map<string, KfStatBucket & { date: string }>();
  for (const r of dailyRows) byDate.set(r.date, r);
  const daily: KfDailyStat[] = [];
  for (let i = 0; i < days; i++) {
    const d = dayFmt.format(new Date(since.getTime() + i * DAY_MS));
    const row = byDate.get(d);
    daily.push(row
      ? { date: d, conversations: row.conversations, customerMessages: row.customerMessages, aiReplies: row.aiReplies, handoffs: row.handoffs, manualReplies: row.manualReplies, blockedSensitive: row.blockedSensitive }
      : { date: d, ...ZERO });
  }
  const today: KfDailyStat = daily.find((x) => x.date === todayStr) ?? { date: todayStr, ...ZERO };

  // 3) "没答上"清单：每条 transferred 出站消息，回溯同会话此前最后一条客户文本消息原文
  const unanswered = await db.select({
    conversationId: kfMessages.conversationId,
    externalUserid: kfConversations.externalUserid,
    transferredAt: kfMessages.createdAt,
    question: sql<string | null>`(
      SELECT m2.content FROM ${kfMessages} m2
      WHERE m2.conversation_id = ${kfMessages.conversationId}
        AND m2.direction = 'in' AND m2.msg_type = 'text' AND m2.content <> ''
        AND m2.created_at <= ${kfMessages.createdAt}
      ORDER BY m2.created_at DESC LIMIT 1
    )`,
    // 敏感词拦截打标：拦截流程先落 blocked_sensitive 审计记录再落本条 transferred（同事务序毫秒级相邻），
    // 用"同会话、transferred 之前 1 分钟内存在 blocked_sensitive"识别，前端标注"触发敏感词拦截"
    sensitiveBlocked: sql<boolean>`EXISTS (
      SELECT 1 FROM ${kfMessages} m3
      WHERE m3.conversation_id = ${kfMessages.conversationId}
        AND m3.direction = 'out' AND m3.ai_action = 'blocked_sensitive'
        AND m3.created_at <= ${kfMessages.createdAt}
        AND m3.created_at > ${kfMessages.createdAt} - interval '1 minute'
    )`,
  })
    .from(kfMessages)
    .innerJoin(kfConversations, eq(kfMessages.conversationId, kfConversations.id))
    .where(and(scope, eq(kfMessages.direction, "out"), eq(kfMessages.aiAction, "transferred")))
    .orderBy(desc(kfMessages.createdAt))
    .limit(Math.max(1, Math.min(50, unansweredLimit)));

  // 4) agentSecret 配置状态（漏配警示用；只读是否配置）
  const [cfg] = await db.select({ agentSecretEnc: workWechatConfigs.agentSecretEnc })
    .from(workWechatConfigs)
    .where(eq(workWechatConfigs.tenantId, tenantId))
    .limit(1);

  return {
    days,
    today,
    period: periodRow
      ? { conversations: periodRow.conversations, customerMessages: periodRow.customerMessages, aiReplies: periodRow.aiReplies, handoffs: periodRow.handoffs, manualReplies: periodRow.manualReplies, blockedSensitive: periodRow.blockedSensitive }
      : { ...ZERO },
    daily,
    unanswered,
    agentSecretConfigured: !!cfg?.agentSecretEnc,
  };
}
