/**
 * T404 + T405 + T406: 热点驱动 + 内容日历引擎 + 日历触发
 *
 * T404: 热点事件 → 自动触发生成建议
 * T405: 栏目规划 + 排期 + 冲突检测（Sub-lib 16）
 * T406: 到期自动触发内容生成任务
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { db } from "../../models/db.js";
import { columnCalendars, contents, knowledgeEntries } from "../../models/schema.js";
import { eq, and, lte, gte, desc, inArray } from "drizzle-orm";
import { crawlerQueue } from "../task/queue.js";
import type { ContentFormat } from "./format-generators.js";

// ============ T405: 栏目规划引擎 ============

export interface ColumnPlan {
  columnName: string;
  frequency: "daily" | "weekly" | "biweekly" | "monthly";
  platforms: string[];
  contentFormats: ContentFormat[];
  topicPool: string[];
}

export interface CalendarEntry {
  id?: string;
  columnName: string;
  scheduledDate: string;       // YYYY-MM-DD
  topic?: string;
  format?: ContentFormat;
  platform?: string;
  status: "planned" | "in_progress" | "ready" | "published" | "cancelled";
  assignee?: string;
}

/**
 * 创建栏目规划
 */
export async function createColumnPlan(
  tenantId: string,
  plan: ColumnPlan
): Promise<CalendarEntry[]> {
  logger.info({ tenantId, columnName: plan.columnName }, "📅 创建栏目规划");

  // 根据频率生成未来 30 天的排期
  const entries: CalendarEntry[] = [];
  const now = new Date();
  const intervalDays = {
    daily: 1,
    weekly: 7,
    biweekly: 14,
    monthly: 30,
  }[plan.frequency];

  let cursor = new Date(now);
  cursor.setDate(cursor.getDate() + 1); // 从明天开始

  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + 30);

  let topicIndex = 0;
  while (cursor <= endDate) {
    const dateStr = cursor.toISOString().slice(0, 10);

    // 检查冲突
    const conflict = await checkConflict(tenantId, dateStr, plan.columnName);
    if (!conflict) {
      const topic = plan.topicPool[topicIndex % plan.topicPool.length] || undefined;
      const format = plan.contentFormats[topicIndex % plan.contentFormats.length] || undefined;
      const platform = plan.platforms[topicIndex % plan.platforms.length] || undefined;

      const entry: CalendarEntry = {
        columnName: plan.columnName,
        scheduledDate: dateStr,
        topic,
        format,
        platform,
        status: "planned",
      };

      // 写入数据库
      const [inserted] = await db.insert(columnCalendars).values({
        tenantId,
        columnName: plan.columnName,
        frequency: plan.frequency,
        platforms: plan.platforms,
        contentFormats: plan.contentFormats,
        topicPool: plan.topicPool,
        scheduledDate: dateStr,
        status: "planned",
        metadata: { topic, format, platform },
      }).returning();

      entry.id = inserted.id;
      entries.push(entry);
      topicIndex++;
    }

    cursor.setDate(cursor.getDate() + intervalDays);
  }

  logger.info(
    { columnName: plan.columnName, entriesCreated: entries.length },
    "📅 栏目排期创建完成"
  );

  return entries;
}

/**
 * 获取日历视图（某段日期内的排期）
 */
export async function getCalendarView(
  tenantId: string,
  startDate: string,
  endDate: string
): Promise<CalendarEntry[]> {
  const rows = await db
    .select()
    .from(columnCalendars)
    .where(
      and(
        eq(columnCalendars.tenantId, tenantId),
        gte(columnCalendars.scheduledDate, startDate),
        lte(columnCalendars.scheduledDate, endDate)
      )
    )
    .orderBy(columnCalendars.scheduledDate);

  return rows.map((r) => {
    const meta = r.metadata as Record<string, unknown> || {};
    return {
      id: r.id,
      columnName: r.columnName,
      scheduledDate: r.scheduledDate!,
      topic: meta.topic as string | undefined,
      format: meta.format as ContentFormat | undefined,
      platform: meta.platform as string | undefined,
      status: r.status as CalendarEntry["status"],
      assignee: r.assignee || undefined,
    };
  });
}

/**
 * 冲突检测：同一天同一栏目不能重复
 */
async function checkConflict(
  tenantId: string,
  date: string,
  columnName: string
): Promise<boolean> {
  const existing = await db
    .select({ id: columnCalendars.id })
    .from(columnCalendars)
    .where(
      and(
        eq(columnCalendars.tenantId, tenantId),
        eq(columnCalendars.scheduledDate, date),
        eq(columnCalendars.columnName, columnName)
      )
    )
    .limit(1);

  return existing.length > 0;
}

// ============ T404: 热点驱动内容生成 ============

export interface TopicSuggestion {
  topic: string;
  angle: string;         // 切入角度
  urgency: "immediate" | "today" | "this_week";
  format: ContentFormat;
  reason: string;        // 推荐理由
}

/**
 * 从热点事件生成选题建议
 */
export async function generateHotTopicSuggestions(
  tenantId: string
): Promise<TopicSuggestion[]> {
  logger.info({ tenantId }, "🔥 热点驱动选题");

  // 获取最近的热点事件
  const recentEvents = await db
    .select()
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.tenantId, tenantId),
        eq(knowledgeEntries.category, "hot_event")
      )
    )
    .orderBy(desc(knowledgeEntries.createdAt))
    .limit(10);

  if (recentEvents.length === 0) {
    return [];
  }

  const eventSummary = recentEvents
    .map((e) => `- ${e.title}: ${e.content?.slice(0, 100)}`)
    .join("\n");

  const response = await chat({
    tenantId,
    userId: "system",
    conversationId: "hot-topic-suggest",
    message: `以下是最近检测到的行业热点事件：

${eventSummary}

请基于这些热点，生成 3-5 个内容选题建议。

直接输出 JSON 数组:
[
  {
    "topic": "选题标题",
    "angle": "切入角度（一句话）",
    "urgency": "immediate|today|this_week",
    "format": "article|spoken|video_script|short_video|long_graphic|infographic|audio|interactive",
    "reason": "推荐理由（一句话）"
  }
]

要求：
- 选题要有热度、有争议、有价值
- 不同形式搭配（不要全是 article）
- urgency: immediate=立刻发, today=今天内, this_week=本周内`,
    skillType: "quality_check",
  });

  try {
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]) as TopicSuggestion[];
  } catch {
    return [];
  }
}

// ============ T406: 日历触发内容生成 ============

/**
 * 检查今日到期的排期，自动触发生成任务
 */
export async function triggerDueCalendarEntries(
  tenantId: string
): Promise<{ triggered: number }> {
  const today = new Date().toISOString().slice(0, 10);

  // 查询今日到期且状态为 planned 的排期
  const dueEntries = await db
    .select()
    .from(columnCalendars)
    .where(
      and(
        eq(columnCalendars.tenantId, tenantId),
        eq(columnCalendars.scheduledDate, today),
        eq(columnCalendars.status, "planned")
      )
    );

  if (dueEntries.length === 0) {
    return { triggered: 0 };
  }

  let triggered = 0;

  for (const entry of dueEntries) {
    const meta = entry.metadata as Record<string, unknown> || {};
    const topic = (meta.topic as string) || entry.columnName;
    const format = (meta.format as ContentFormat) || "article";

    // 添加到内容生成队列
    await crawlerQueue.add("calendar-generate", {
      type: "calendar-generate" as any,
      tenantId,
      payload: {
        calendarId: entry.id,
        columnName: entry.columnName,
        topic,
        format,
        platform: meta.platform,
      },
    });

    // 更新状态为 in_progress
    await db
      .update(columnCalendars)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(columnCalendars.id, entry.id));

    triggered++;
  }

  logger.info({ tenantId, triggered, date: today }, "📅 日历触发内容生成");

  return { triggered };
}
