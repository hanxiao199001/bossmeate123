/**
 * T308: 热点事件时间线追踪
 *
 * 对已发现的热点事件进行演化追踪：
 * - 关联多次检测的同一事件
 * - 构建事件时间线
 * - 评估事件影响力变化
 * - 判断事件生命周期阶段
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { searchVectors, type VectorCategory } from "../knowledge/vector-store.js";
import { getEmbedding } from "../knowledge/embedding-service.js";
import { db } from "../../models/db.js";
import { knowledgeEntries } from "../../models/schema.js";
import { eq, and, desc } from "drizzle-orm";

// ============ 类型定义 ============

export interface TimelineNode {
  eventId: string;
  title: string;
  summary: string;
  detectedAt: string;
  severity: string;
  similarity: number;       // 与主事件的相似度
}

export interface EventTimeline {
  mainEvent: string;         // 主事件标题
  category: string;
  currentPhase: "emerging" | "peaking" | "sustaining" | "fading";
  impactScore: number;       // 0-100
  nodes: TimelineNode[];
  trend: "escalating" | "stable" | "declining";
  recommendation: string;    // 内容创作建议
}

// ============ 核心逻辑 ============

/**
 * 构建某个事件的时间线
 */
export async function buildEventTimeline(
  eventTitle: string,
  tenantId: string
): Promise<EventTimeline | null> {
  logger.info({ eventTitle, tenantId }, "📊 构建事件时间线");

  // 1. 向量搜索找到所有相关事件条目
  const { vector } = await getEmbedding(eventTitle);
  const relatedEntries = await searchVectors({
    vector,
    tenantId,
    category: "hot_event" as VectorCategory,
    limit: 20,
  });

  if (relatedEntries.length === 0) {
    return null;
  }

  // 2. 构建时间线节点
  const nodes: TimelineNode[] = relatedEntries
    .filter((e) => {
      const similarity = 1 / (1 + e._distance);
      return similarity > 0.6;
    })
    .map((e) => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(e.metadata || "{}"); } catch {}
      return {
        eventId: e.id,
        title: e.title || eventTitle,
        summary: (e.content || "").slice(0, 200),
        detectedAt: (meta.detectedAt as string) || e.createdAt || new Date().toISOString(),
        severity: (meta.severity as string) || "medium",
        similarity: 1 / (1 + e._distance),
      };
    })
    .sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime());

  if (nodes.length === 0) {
    return null;
  }

  // 3. 分析事件阶段和趋势
  const phase = analyzePhase(nodes);
  const trend = analyzeTrend(nodes);
  const impactScore = calculateImpact(nodes);

  // 4. AI 生成内容创作建议
  const recommendation = await generateRecommendation(eventTitle, nodes, phase, tenantId);

  const timeline: EventTimeline = {
    mainEvent: eventTitle,
    category: (nodes[0]?.severity) || "medium",
    currentPhase: phase,
    impactScore,
    nodes,
    trend,
    recommendation,
  };

  logger.info(
    { eventTitle, nodesCount: nodes.length, phase, trend, impactScore },
    "📊 事件时间线构建完成"
  );

  return timeline;
}

/**
 * 获取所有活跃事件的时间线摘要
 */
export async function getActiveEventTimelines(
  tenantId: string
): Promise<EventTimeline[]> {
  // 获取最近 7 天的热点事件
  const recentEntries = await db
    .select()
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.tenantId, tenantId),
        eq(knowledgeEntries.category, "hot_event")
      )
    )
    .orderBy(desc(knowledgeEntries.createdAt))
    .limit(50);

  // 按标题聚合（去重相似事件）
  const eventGroups = groupSimilarEvents(recentEntries);
  const timelines: EventTimeline[] = [];

  for (const group of eventGroups.slice(0, 10)) {
    const timeline = await buildEventTimeline(group.title, tenantId);
    if (timeline) {
      timelines.push(timeline);
    }
  }

  return timelines;
}

// ============ 分析工具 ============

function analyzePhase(nodes: TimelineNode[]): EventTimeline["currentPhase"] {
  if (nodes.length <= 1) return "emerging";

  const now = Date.now();
  const latestNode = nodes[nodes.length - 1];
  const latestTime = new Date(latestNode.detectedAt).getTime();
  const hoursSinceLatest = (now - latestTime) / 3600000;

  // 最近 6 小时内有新检测 → peaking 或 emerging
  if (hoursSinceLatest < 6) {
    return nodes.length >= 3 ? "peaking" : "emerging";
  }

  // 24 小时内 → sustaining
  if (hoursSinceLatest < 24) {
    return "sustaining";
  }

  // 超过 24 小时 → fading
  return "fading";
}

function analyzeTrend(nodes: TimelineNode[]): EventTimeline["trend"] {
  if (nodes.length < 2) return "stable";

  const severityMap = { high: 3, medium: 2, low: 1 };
  const recentHalf = nodes.slice(Math.floor(nodes.length / 2));
  const olderHalf = nodes.slice(0, Math.floor(nodes.length / 2));

  const recentAvg = recentHalf.reduce(
    (s, n) => s + (severityMap[n.severity as keyof typeof severityMap] || 2), 0
  ) / recentHalf.length;

  const olderAvg = olderHalf.reduce(
    (s, n) => s + (severityMap[n.severity as keyof typeof severityMap] || 2), 0
  ) / olderHalf.length;

  if (recentAvg > olderAvg + 0.5) return "escalating";
  if (recentAvg < olderAvg - 0.5) return "declining";
  return "stable";
}

function calculateImpact(nodes: TimelineNode[]): number {
  const severityMap = { high: 40, medium: 25, low: 10 };
  const baseScore = nodes.reduce(
    (s, n) => s + (severityMap[n.severity as keyof typeof severityMap] || 15), 0
  );
  // 节点数量加分，但递减
  const countBonus = Math.min(nodes.length * 5, 30);
  // 跨度加分（天数）
  if (nodes.length >= 2) {
    const first = new Date(nodes[0].detectedAt).getTime();
    const last = new Date(nodes[nodes.length - 1].detectedAt).getTime();
    const days = (last - first) / 86400000;
    const spanBonus = Math.min(days * 3, 15);
    return Math.min(Math.round(baseScore / nodes.length + countBonus + spanBonus), 100);
  }
  return Math.min(Math.round(baseScore + countBonus), 100);
}

function groupSimilarEvents(
  entries: Array<{ title: string | null; content: string; metadata: unknown }>
): Array<{ title: string; count: number }> {
  const groups = new Map<string, number>();

  for (const entry of entries) {
    const title = entry.title?.replace(/^热点:\s*/, "") || "未知事件";
    // 简单文本匹配去重
    let matched = false;
    for (const [key] of groups) {
      if (
        key.includes(title.slice(0, 6)) ||
        title.includes(key.slice(0, 6))
      ) {
        groups.set(key, (groups.get(key) || 0) + 1);
        matched = true;
        break;
      }
    }
    if (!matched) {
      groups.set(title, 1);
    }
  }

  return Array.from(groups.entries())
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count);
}

async function generateRecommendation(
  eventTitle: string,
  nodes: TimelineNode[],
  phase: string,
  tenantId: string
): Promise<string> {
  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "event-timeline",
      message: `事件: ${eventTitle}
阶段: ${phase}
时间线节点数: ${nodes.length}
最新检测: ${nodes[nodes.length - 1]?.detectedAt}

用一句话给出内容创作建议（从学术自媒体角度，30字以内）：`,
      skillType: "daily_chat",
    });
    return response.content.trim();
  } catch {
    return phase === "emerging" ? "抢先解读，抓住流量窗口" : "深度分析，提供独特视角";
  }
}
