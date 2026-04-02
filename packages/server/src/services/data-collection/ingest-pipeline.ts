/**
 * T306: 采集数据 → 审核管线 → 入库对接
 *
 * 将爬虫产出的原始数据转换为知识条目，经过 5 道审核后入库各子库。
 * 支持：关键词→keyword子库、竞品→content_format子库、热点→hot_event子库等
 */

import { logger } from "../../config/logger.js";
import { runAuditPipeline, runBatchAudit, type AuditInput } from "../knowledge/audit-pipeline.js";
import type { CrawlerResult, HotKeywordItem } from "../crawler/types.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 爬虫结果 → 审核入库 ============

/**
 * 将爬虫关键词结果转换为知识条目并审核入库
 */
export async function ingestKeywordsToKnowledge(
  crawlerResults: CrawlerResult[],
  tenantId: string
): Promise<{ ingested: number; rejected: number }> {
  const auditInputs: AuditInput[] = [];

  for (const result of crawlerResults) {
    if (!result.success || result.keywords.length === 0) continue;

    for (const kw of result.keywords) {
      // 只入库有意义的关键词
      if (kw.keyword.length < 4 || kw.heatScore < 10) continue;

      auditInputs.push({
        tenantId,
        category: "keyword" as VectorCategory,
        title: kw.keyword,
        content: buildKeywordContent(kw),
        source: `crawler:${kw.platform}`,
        metadata: {
          platform: kw.platform,
          heatScore: kw.heatScore,
          trend: kw.trend,
          discipline: kw.discipline,
          crawledAt: kw.crawledAt,
        },
      });
    }
  }

  if (auditInputs.length === 0) {
    return { ingested: 0, rejected: 0 };
  }

  // 限制单次批量，避免过载
  const batch = auditInputs.slice(0, 50);
  const { accepted, rejected } = await runBatchAudit(batch);

  logger.info(
    { total: batch.length, ingested: accepted.length, rejected: rejected.length },
    "关键词→知识库入库完成"
  );

  return { ingested: accepted.length, rejected: rejected.length };
}

/**
 * 将期刊数据转换为领域知识条目并审核入库
 */
export async function ingestJournalsToKnowledge(
  crawlerResults: CrawlerResult[],
  tenantId: string
): Promise<{ ingested: number; rejected: number }> {
  const auditInputs: AuditInput[] = [];

  for (const result of crawlerResults) {
    if (!result.success || result.journals.length === 0) continue;

    for (const journal of result.journals) {
      auditInputs.push({
        tenantId,
        category: "domain_knowledge" as VectorCategory,
        title: `期刊: ${journal.name}`,
        content: buildJournalContent(journal),
        source: `crawler:${journal.platform}`,
        metadata: {
          issn: journal.issn,
          discipline: journal.discipline,
          partition: journal.partition,
          impactFactor: journal.impactFactor,
          isWarningList: journal.isWarningList,
        },
      });
    }
  }

  if (auditInputs.length === 0) {
    return { ingested: 0, rejected: 0 };
  }

  const batch = auditInputs.slice(0, 30);
  const { accepted, rejected } = await runBatchAudit(batch);

  logger.info(
    { total: batch.length, ingested: accepted.length, rejected: rejected.length },
    "期刊→知识库入库完成"
  );

  return { ingested: accepted.length, rejected: rejected.length };
}

/**
 * 通用：将任意文本内容审核入库到指定子库
 */
export async function ingestToKnowledge(
  items: Array<{
    title: string;
    content: string;
    category: VectorCategory;
    source: string;
    metadata?: Record<string, unknown>;
  }>,
  tenantId: string
): Promise<{ ingested: number; rejected: number }> {
  const auditInputs: AuditInput[] = items.map((item) => ({
    tenantId,
    category: item.category,
    title: item.title,
    content: item.content,
    source: item.source,
    metadata: item.metadata,
  }));

  const { accepted, rejected } = await runBatchAudit(auditInputs);

  logger.info(
    { total: items.length, ingested: accepted.length, rejected: rejected.length },
    `通用知识入库完成 → ${items[0]?.category}`
  );

  return { ingested: accepted.length, rejected: rejected.length };
}

// ============ 内容构建 ============

function buildKeywordContent(kw: HotKeywordItem): string {
  const parts = [
    `关键词: ${kw.keyword}`,
    `来源平台: ${kw.platform}`,
    `热度分: ${kw.heatScore}`,
    `趋势: ${kw.trend}`,
    `学科: ${kw.discipline}`,
  ];
  if (kw.description) parts.push(`描述: ${kw.description}`);
  return parts.join("\n");
}

function buildJournalContent(journal: {
  name: string;
  nameCn?: string;
  discipline: string;
  partition?: string;
  impactFactor?: number;
  acceptanceRate?: number;
  reviewCycle?: string;
  annualVolume?: number;
  isWarningList?: boolean;
}): string {
  const parts = [
    `期刊名称: ${journal.name}`,
    journal.nameCn ? `中文名: ${journal.nameCn}` : "",
    `学科领域: ${journal.discipline}`,
    journal.partition ? `分区: ${journal.partition}` : "",
    journal.impactFactor != null ? `影响因子: ${journal.impactFactor}` : "",
    journal.acceptanceRate != null ? `录用率: ${(journal.acceptanceRate * 100).toFixed(1)}%` : "",
    journal.reviewCycle ? `审稿周期: ${journal.reviewCycle}` : "",
    journal.annualVolume != null ? `年发文量: ${journal.annualVolume}` : "",
    journal.isWarningList ? `⚠️ 中科院预警名单` : "",
  ];
  return parts.filter(Boolean).join("\n");
}
