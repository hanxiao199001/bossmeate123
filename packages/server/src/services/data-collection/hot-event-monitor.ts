/**
 * T303: 行业热点事件监控服务
 *
 * 定时爬取社交媒体热搜 → AI 识别行业热点事件 → 入库 Sub-lib 14（hot_event）
 * 支持热点事件的自动发现、分类、影响评估
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { db } from "../../models/db.js";
import { keywords, tenants } from "../../models/schema.js";
import { eq, desc, gte } from "drizzle-orm";
import { ingestToKnowledge } from "./ingest-pipeline.js";
import { crawlByTrack } from "../crawler/index.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型定义 ============

export interface HotEvent {
  title: string;
  summary: string;
  category: string;        // 学术动态 | 政策变化 | 行业争议 | 技术突破 | 期刊事件
  severity: "high" | "medium" | "low";
  platforms: string[];
  relatedKeywords: string[];
  contentAngle: string;     // 建议的内容切入角度
  detectedAt: string;
}

// ============ 核心逻辑 ============

/**
 * 检测热点事件（主入口）
 */
export async function detectHotEvents(tenantId: string): Promise<HotEvent[]> {
  logger.info({ tenantId }, "🔥 开始热点事件监控");

  // 1. 获取最近的热门关键词（高热度、多平台出现）
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const hotKeywords = await db
    .select()
    .from(keywords)
    .where(eq(keywords.tenantId, tenantId))
    .orderBy(desc(keywords.compositeScore))
    .limit(30);

  // 2. 补充抓取社交媒体最新热搜
  let socialKeywords: string[] = [];
  try {
    const socialResults = await crawlByTrack("social");
    for (const r of socialResults) {
      if (r.success && r.items) {
        socialKeywords.push(...r.items.map((i) => i.keyword));
      }
      if (r.success && r.keywords) {
        socialKeywords.push(...r.keywords.map((k) => k.keyword));
      }
    }
  } catch (err) {
    logger.warn({ err }, "社交媒体热搜抓取失败，使用数据库关键词");
  }

  // 3. 合并关键词，用 AI 识别热点事件
  const allKeywords = [
    ...hotKeywords.map((k) => `${k.keyword}(热度:${k.compositeScore}, 平台:${k.sourcePlatform})`),
    ...socialKeywords.slice(0, 20),
  ];

  if (allKeywords.length === 0) {
    logger.info("没有足够的关键词数据，跳过热点检测");
    return [];
  }

  const events = await identifyEventsWithAI(allKeywords, tenantId);

  // 4. 入库 Sub-lib 14
  if (events.length > 0) {
    await ingestEventsToKnowledge(events, tenantId);
  }

  logger.info({ tenantId, eventsDetected: events.length }, "🔥 热点事件监控完成");
  return events;
}

/**
 * AI 识别热点事件
 */
async function identifyEventsWithAI(
  keywordList: string[],
  tenantId: string
): Promise<HotEvent[]> {
  const prompt = `你是一个学术自媒体行业热点分析专家。

以下是今日各平台的热门关键词列表：
${keywordList.join("\n")}

请从中识别出与【学术出版/科研/期刊/论文/教育】相关的热点事件。

对每个事件，输出以下 JSON 格式（直接输出 JSON 数组，不要其他文字）：
[
  {
    "title": "事件标题（15字以内）",
    "summary": "事件概要（50-100字）",
    "category": "学术动态|政策变化|行业争议|技术突破|期刊事件",
    "severity": "high|medium|low",
    "relatedKeywords": ["关键词1", "关键词2"],
    "contentAngle": "建议的内容创作切入角度（一句话）"
  }
]

如果没有相关热点事件，输出空数组 []。
最多识别 5 个事件，优先输出 severity=high 的。`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "hot-event-monitor",
      message: prompt,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      title: string;
      summary: string;
      category: string;
      severity: string;
      relatedKeywords: string[];
      contentAngle: string;
    }>;

    return parsed.map((e) => ({
      title: e.title,
      summary: e.summary,
      category: e.category,
      severity: (e.severity as HotEvent["severity"]) || "medium",
      platforms: [],
      relatedKeywords: e.relatedKeywords || [],
      contentAngle: e.contentAngle || "",
      detectedAt: new Date().toISOString(),
    }));
  } catch (err) {
    logger.error({ err }, "AI 热点事件识别失败");
    return [];
  }
}

/**
 * 热点事件 → 知识库 Sub-lib 14
 */
async function ingestEventsToKnowledge(events: HotEvent[], tenantId: string) {
  const items = events.map((e) => ({
    title: `热点: ${e.title}`,
    content: [
      `事件: ${e.title}`,
      `概要: ${e.summary}`,
      `类别: ${e.category}`,
      `严重度: ${e.severity}`,
      `相关关键词: ${e.relatedKeywords.join(", ")}`,
      `内容切入角度: ${e.contentAngle}`,
      `发现时间: ${e.detectedAt}`,
    ].join("\n"),
    category: "hot_event" as VectorCategory,
    source: "hot-event-monitor",
    metadata: {
      category: e.category,
      severity: e.severity,
      platforms: e.platforms,
      relatedKeywords: e.relatedKeywords,
    },
  }));

  return ingestToKnowledge(items, tenantId);
}
