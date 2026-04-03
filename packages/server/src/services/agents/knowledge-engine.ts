/**
 * KnowledgeEngine Agent
 *
 * 知识引擎：负责知识库的持续补充与质量提升
 * Phase 1: 抓取同行内容 → 提取知识
 * Phase 2: 增强学术内容（PMC 全文）
 * Phase 3: 从老板反馈中学习
 * Phase 4: 健康检查
 */

import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { db } from "../../models/db.js";
import {
  competitors,
  peerContentCrawls,
  knowledgeEntries,
  bossEdits,
  tenants,
} from "../../models/schema.js";
import { eq, and, gte, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { ingestToKnowledge } from "../data-collection/ingest-pipeline.js";
import { logAgentAction, updateAgentLog } from "./base/agent-logger.js";
import type {
  IAgent,
  AgentConfig,
  AgentContext,
  AgentResult,
  AgentStatus,
  AgentTask,
  AgentTaskResult,
} from "./base/types.js";

export class KnowledgeEngine implements IAgent {
  readonly name = "knowledge-engine";
  readonly displayName = "Knowledge Engine";

  private status: AgentStatus = "idle";
  private config: AgentConfig = { concurrency: 1, maxRetries: 3, timeoutMs: 300_000 };

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    this.status = "idle";
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  async shutdown(): Promise<void> {
    this.status = "shutdown";
  }

  async handleTask(task: AgentTask): Promise<AgentTaskResult> {
    const start = Date.now();
    try {
      const ctx: AgentContext = {
        tenantId: task.input.tenantId as string,
        date: new Date().toISOString().slice(0, 10),
        triggeredBy: "manual",
      };
      const result = await this.execute(ctx);
      return {
        taskId: task.id,
        success: result.success,
        output: result,
        metrics: { durationMs: Date.now() - start, tokensUsed: 0 },
      };
    } catch (err: any) {
      return {
        taskId: task.id,
        success: false,
        error: err.message,
        metrics: { durationMs: Date.now() - start, tokensUsed: 0 },
      };
    }
  }

  async execute(context: AgentContext): Promise<AgentResult> {
    const start = Date.now();
    this.status = "running";

    const logId = await logAgentAction({
      tenantId: context.tenantId,
      agentName: this.name,
      action: "execute",
      status: "running",
      input: { date: context.date, triggeredBy: context.triggeredBy },
    });

    const details: unknown[] = [];
    let tasksCompleted = 0;
    let tasksFailed = 0;

    // Phase 1: 抓取同行内容
    try {
      const r = await this.crawlPeerContent(context.tenantId);
      details.push({ phase: "crawlPeerContent", ...r });
      tasksCompleted++;
    } catch (err: any) {
      logger.error({ err, tenantId: context.tenantId }, "crawlPeerContent failed");
      details.push({ phase: "crawlPeerContent", error: err.message });
      tasksFailed++;
    }

    // Phase 2: 增强学术内容
    try {
      const r = await this.enhanceAcademicContent(context.tenantId);
      details.push({ phase: "enhanceAcademicContent", ...r });
      tasksCompleted++;
    } catch (err: any) {
      logger.error({ err, tenantId: context.tenantId }, "enhanceAcademicContent failed");
      details.push({ phase: "enhanceAcademicContent", error: err.message });
      tasksFailed++;
    }

    // Phase 3: 从老板反馈学习
    try {
      const r = await this.learnFromBossFeedback(context.tenantId);
      details.push({ phase: "learnFromBossFeedback", ...r });
      tasksCompleted++;
    } catch (err: any) {
      logger.error({ err, tenantId: context.tenantId }, "learnFromBossFeedback failed");
      details.push({ phase: "learnFromBossFeedback", error: err.message });
      tasksFailed++;
    }

    // Phase 4: 健康检查
    try {
      const r = await this.healthCheck(context.tenantId);
      details.push({ phase: "healthCheck", ...r });
      tasksCompleted++;
    } catch (err: any) {
      logger.error({ err, tenantId: context.tenantId }, "healthCheck failed");
      details.push({ phase: "healthCheck", error: err.message });
      tasksFailed++;
    }

    this.status = "idle";
    const durationMs = Date.now() - start;

    await updateAgentLog(logId, {
      status: tasksFailed > 0 ? "completed" : "completed",
      output: { details },
      durationMs,
    });

    return {
      agentName: this.name,
      success: tasksFailed === 0,
      tasksCompleted,
      tasksFailed,
      summary: `KnowledgeEngine: ${tasksCompleted} phases done, ${tasksFailed} failed`,
      details,
      durationMs,
    };
  }

  // ============ Phase 1: 抓取同行内容 ============
  private async crawlPeerContent(tenantId: string) {
    const peerRows = await db
      .select()
      .from(competitors)
      .where(eq(competitors.tenantId, tenantId))
      .limit(50);

    let newCount = 0;
    let skipped = 0;
    let ingested = 0;

    for (const peer of peerRows) {
      if (!peer.articleContent) {
        skipped++;
        continue;
      }

      const contentHash = createHash("sha256")
        .update(peer.articleContent)
        .digest("hex");

      // dedup check
      const existing = await db
        .select({ id: peerContentCrawls.id })
        .from(peerContentCrawls)
        .where(
          and(
            eq(peerContentCrawls.tenantId, tenantId),
            eq(peerContentCrawls.contentHash, contentHash)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // AI extract knowledge (cheap model)
      let extractedKnowledge = "";
      try {
        const aiResult = await chat({
          tenantId,
          userId: "system",
          conversationId: nanoid(),
          message: `从以下文章中提取关键知识点、写作技巧和选题策略，用JSON格式输出：
标题: ${peer.articleTitle || "无"}
内容: ${(peer.articleContent || "").slice(0, 3000)}`,
          skillType: "knowledge_extract",
        });
        extractedKnowledge = aiResult.content || "";
      } catch {
        extractedKnowledge = peer.articleContent.slice(0, 1000);
      }

      // Ingest to knowledge
      const result = await ingestToKnowledge(
        [
          {
            title: peer.articleTitle || "同行内容",
            content: extractedKnowledge,
            category: "insight" as any,
            source: peer.articleUrl || `competitor:${peer.accountId}`,
            metadata: {
              platform: peer.platform,
              competitorAccount: peer.accountName,
              contentType: peer.contentType,
            },
          },
        ],
        tenantId
      );

      // Record crawl
      await db.insert(peerContentCrawls).values({
        id: nanoid(16),
        tenantId,
        competitorId: peer.accountId,
        platform: peer.platform,
        originalUrl: peer.articleUrl || "",
        title: peer.articleTitle || "",
        contentHash,
        readCount: (peer.publicMetrics as any)?.views || null,
        likeCount: (peer.publicMetrics as any)?.likes || null,
        knowledgeExtracted: true,
        entriesCreated: result.ingested,
      });

      newCount++;
      ingested += result.ingested;
    }

    logger.info({ tenantId, newCount, skipped, ingested }, "crawlPeerContent completed");
    return { newCount, skipped, ingested };
  }

  // ============ Phase 2: 增强学术内容 ============
  private async enhanceAcademicContent(tenantId: string) {
    const shortEntries = await db
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.tenantId, tenantId),
          eq(knowledgeEntries.category, "domain_knowledge"),
          sql`length(${knowledgeEntries.content}) < 500`
        )
      )
      .limit(10);

    let enhanced = 0;

    for (const entry of shortEntries) {
      // Try to find PMC fulltext via eutils API
      const titleKeywords = (entry.title || "").replace(/[^\w\s]/g, "").trim();
      if (!titleKeywords) continue;

      try {
        const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pmc&retmode=json&retmax=1&term=${encodeURIComponent(titleKeywords)}`;
        const searchResp = await fetch(searchUrl);
        const searchData = (await searchResp.json()) as any;

        const pmcIds = searchData?.esearchresult?.idlist;
        if (!pmcIds || pmcIds.length === 0) continue;

        const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&rettype=xml&id=${pmcIds[0]}`;
        const fetchResp = await fetch(fetchUrl);
        const xmlText = await fetchResp.text();

        // Extract abstract text from XML (simplified)
        const abstractMatch = xmlText.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i);
        if (abstractMatch) {
          const cleanAbstract = abstractMatch[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          if (cleanAbstract.length > 200) {
            // Update the entry with enriched content
            await db
              .update(knowledgeEntries)
              .set({
                content: `${entry.content}\n\n--- PMC Full Abstract ---\n${cleanAbstract}`,
                updatedAt: new Date(),
              })
              .where(eq(knowledgeEntries.id, entry.id));
            enhanced++;
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message, entryId: entry.id }, "PMC fetch failed");
      }
    }

    logger.info({ tenantId, candidates: shortEntries.length, enhanced }, "enhanceAcademicContent completed");
    return { candidates: shortEntries.length, enhanced };
  }

  // ============ Phase 3: 从老板反馈学习 ============
  private async learnFromBossFeedback(tenantId: string) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentEdits = await db
      .select()
      .from(bossEdits)
      .where(
        and(
          eq(bossEdits.tenantId, tenantId),
          gte(bossEdits.createdAt, sevenDaysAgo)
        )
      )
      .limit(50);

    if (recentEdits.length === 0) {
      return { editsAnalyzed: 0, patternsLearned: 0 };
    }

    // Prepare edit summaries for AI
    const editSummaries = recentEdits.map((e) => ({
      action: e.action,
      originalTitle: e.originalTitle?.slice(0, 100),
      editedTitle: e.editedTitle?.slice(0, 100),
      editDistance: e.editDistance,
      rejectReason: e.rejectReason,
    }));

    let patterns = "";
    try {
      const aiResult = await chat({
        tenantId,
        userId: "system",
        conversationId: nanoid(),
        message: `分析以下老板审核/修改记录，提炼写作风格偏好和修改规律。输出结构化的风格指导规则：
${JSON.stringify(editSummaries, null, 2)}`,
        skillType: "style_analysis",
      });
      patterns = aiResult.content || "";
    } catch {
      patterns = `共${recentEdits.length}条修改记录待分析`;
    }

    // Ingest to style sub-lib
    const result = await ingestToKnowledge(
      [
        {
          title: `老板风格偏好 ${new Date().toISOString().slice(0, 10)}`,
          content: patterns,
          category: "style" as any,
          source: "boss_feedback_learning",
          metadata: { editCount: recentEdits.length, period: "7d" },
        },
      ],
      tenantId
    );

    logger.info(
      { tenantId, editsAnalyzed: recentEdits.length, ingested: result.ingested },
      "learnFromBossFeedback completed"
    );
    return { editsAnalyzed: recentEdits.length, patternsLearned: result.ingested };
  }

  // ============ Phase 4: 健康检查 ============
  private async healthCheck(tenantId: string) {
    const categories = [
      "term", "redline", "audience", "content_format", "keyword",
      "style", "platform_rule", "insight", "hot_event", "domain_knowledge",
    ];

    const counts: Record<string, number> = {};
    const warnings: string[] = [];

    for (const cat of categories) {
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeEntries)
        .where(
          and(
            eq(knowledgeEntries.tenantId, tenantId),
            eq(knowledgeEntries.category, cat)
          )
        );
      const count = Number(result[0]?.count ?? 0);
      counts[cat] = count;

      if (count < 5) {
        warnings.push(`${cat}: only ${count} entries (recommend >= 5)`);
      }
    }

    if (warnings.length > 0) {
      logger.warn({ tenantId, warnings }, "Knowledge health check warnings");
    } else {
      logger.info({ tenantId, counts }, "Knowledge health check passed");
    }

    return { counts, warnings };
  }
}
