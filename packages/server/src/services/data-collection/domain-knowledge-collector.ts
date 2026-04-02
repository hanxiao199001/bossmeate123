/**
 * T304: 领域知识自动采集
 *
 * 多源数据采集 → Sub-lib 15（domain_knowledge）
 * 数据来源：
 * - 期刊数据（LetPub、OpenAlex）
 * - 学科术语（PubMed、arXiv）
 * - 政策法规（policy-monitor）
 * - 行业标准和趋势
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { crawlByTrack, crawlPlatform } from "../crawler/index.js";
import { ingestToKnowledge } from "./ingest-pipeline.js";
import { db } from "../../models/db.js";
import { journals, tenantIpProfiles } from "../../models/schema.js";
import { eq } from "drizzle-orm";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 核心逻辑 ============

/**
 * 领域知识采集主入口
 */
export async function collectDomainKnowledge(
  tenantId: string
): Promise<{ sources: Record<string, number>; totalIngested: number }> {
  logger.info({ tenantId }, "📚 开始领域知识采集");

  const sources: Record<string, number> = {};
  let totalIngested = 0;

  // 1. 获取租户行业信息
  const ipProfile = await db
    .select()
    .from(tenantIpProfiles)
    .where(eq(tenantIpProfiles.tenantId, tenantId))
    .limit(1);

  const industry = ipProfile[0]?.industry || "学术出版";

  // 2. 从 SCI 线爬虫获取最新期刊数据
  try {
    const sciResults = await crawlByTrack("sci");
    const journalKnowledge = await extractJournalKnowledge(sciResults, tenantId);
    sources["期刊数据"] = journalKnowledge;
    totalIngested += journalKnowledge;
  } catch (err) {
    logger.warn({ err }, "SCI线数据采集失败");
  }

  // 3. 从政策爬虫获取最新政策
  try {
    const policyResult = await crawlPlatform("policy-monitor");
    if (policyResult.success && policyResult.keywords.length > 0) {
      const policyKnowledge = await extractPolicyKnowledge(policyResult.keywords, tenantId);
      sources["政策法规"] = policyKnowledge;
      totalIngested += policyKnowledge;
    }
  } catch (err) {
    logger.warn({ err }, "政策数据采集失败");
  }

  // 4. AI 生成行业知识摘要
  try {
    const aiKnowledge = await generateIndustryKnowledge(industry, tenantId);
    sources["AI行业分析"] = aiKnowledge;
    totalIngested += aiKnowledge;
  } catch (err) {
    logger.warn({ err }, "AI行业知识生成失败");
  }

  // 5. 从已有期刊库提取结构化知识
  try {
    const structuredKnowledge = await extractFromJournalDB(tenantId);
    sources["期刊库结构化"] = structuredKnowledge;
    totalIngested += structuredKnowledge;
  } catch (err) {
    logger.warn({ err }, "期刊库知识提取失败");
  }

  logger.info(
    { tenantId, sources, totalIngested },
    "📚 领域知识采集完成"
  );

  return { sources, totalIngested };
}

// ============ 各数据源处理 ============

async function extractJournalKnowledge(
  sciResults: Awaited<ReturnType<typeof crawlByTrack>>,
  tenantId: string
): Promise<number> {
  const items: Array<{
    title: string;
    content: string;
    category: VectorCategory;
    source: string;
    metadata?: Record<string, unknown>;
  }> = [];

  for (const result of sciResults) {
    if (!result.success) continue;

    for (const journal of result.journals.slice(0, 20)) {
      items.push({
        title: `期刊知识: ${journal.name}`,
        content: [
          `领域知识 - 期刊信息`,
          `期刊: ${journal.name}${journal.nameCn ? ` (${journal.nameCn})` : ""}`,
          `学科: ${journal.discipline}`,
          journal.partition ? `JCR分区: ${journal.partition}` : "",
          journal.impactFactor != null ? `影响因子: ${journal.impactFactor}` : "",
          journal.acceptanceRate != null ? `录用率: ${(journal.acceptanceRate * 100).toFixed(1)}%` : "",
          journal.reviewCycle ? `审稿周期: ${journal.reviewCycle}` : "",
          journal.isWarningList ? `风险提示: 该期刊在中科院预警名单中` : "",
          journal.isOA ? `开放获取: 是` : "",
        ].filter(Boolean).join("\n"),
        category: "domain_knowledge" as VectorCategory,
        source: `crawler:${result.platform}`,
        metadata: { discipline: journal.discipline, partition: journal.partition },
      });
    }
  }

  if (items.length === 0) return 0;
  const result = await ingestToKnowledge(items, tenantId);
  return result.ingested;
}

async function extractPolicyKnowledge(
  policyKeywords: Array<{ keyword: string; description?: string; discipline: string }>,
  tenantId: string
): Promise<number> {
  const items = policyKeywords.slice(0, 15).map((kw) => ({
    title: `政策动态: ${kw.keyword}`,
    content: [
      `领域知识 - 政策法规`,
      `政策关键词: ${kw.keyword}`,
      `相关学科: ${kw.discipline}`,
      kw.description ? `详情: ${kw.description}` : "",
      `来源: 政策监控爬虫`,
      `采集时间: ${new Date().toISOString().slice(0, 10)}`,
    ].filter(Boolean).join("\n"),
    category: "domain_knowledge" as VectorCategory,
    source: "crawler:policy-monitor",
    metadata: { discipline: kw.discipline, type: "policy" },
  }));

  if (items.length === 0) return 0;
  const result = await ingestToKnowledge(items, tenantId);
  return result.ingested;
}

async function generateIndustryKnowledge(
  industry: string,
  tenantId: string
): Promise<number> {
  const prompt = `你是一个${industry}领域的知识专家。

请生成 5 条该领域的核心知识条目，每条包含：
- 一个知识点标题
- 100-200字的知识内容

直接输出 JSON 数组格式：
[
  {"title": "知识点标题", "content": "知识内容详情..."}
]

要求：
- 内容必须是专业、准确、实用的行业知识
- 涵盖：行业标准、最佳实践、常见误区、发展趋势、关键概念
- 适合内容创作者参考引用`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "domain-knowledge",
      message: prompt,
      skillType: "knowledge_search",
    });

    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ title: string; content: string }>;

    const items = parsed.map((k) => ({
      title: `行业知识: ${k.title}`,
      content: `领域知识 - ${industry}\n\n${k.content}`,
      category: "domain_knowledge" as VectorCategory,
      source: "ai:industry-analysis",
      metadata: { industry, generatedBy: "ai" },
    }));

    const result = await ingestToKnowledge(items, tenantId);
    return result.ingested;
  } catch (err) {
    logger.error({ err }, "AI 行业知识生成失败");
    return 0;
  }
}

async function extractFromJournalDB(tenantId: string): Promise<number> {
  // 提取高影响因子期刊的结构化知识
  const topJournals = await db
    .select()
    .from(journals)
    .where(eq(journals.tenantId, tenantId))
    .limit(20);

  if (topJournals.length === 0) return 0;

  // 按学科分组生成知识摘要
  const disciplineMap = new Map<string, typeof topJournals>();
  for (const j of topJournals) {
    const disc = j.discipline || "其他";
    if (!disciplineMap.has(disc)) disciplineMap.set(disc, []);
    disciplineMap.get(disc)!.push(j);
  }

  const items = Array.from(disciplineMap.entries()).map(([discipline, jList]) => ({
    title: `学科概览: ${discipline}`,
    content: [
      `领域知识 - ${discipline}学科期刊概览`,
      `收录期刊数: ${jList.length}`,
      `期刊列表:`,
      ...jList.map(
        (j) =>
          `- ${j.name}${j.partition ? ` (${j.partition})` : ""}${j.impactFactor ? ` IF=${j.impactFactor}` : ""}${j.isWarningList ? " ⚠️预警" : ""}`
      ),
    ].join("\n"),
    category: "domain_knowledge" as VectorCategory,
    source: "database:journals",
    metadata: { discipline, journalCount: jList.length },
  }));

  const result = await ingestToKnowledge(items, tenantId);
  return result.ingested;
}
