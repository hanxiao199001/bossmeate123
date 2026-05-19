/**
 * 5-23 PR #161 — admin-only 路由 (Workbench v2 + bulk-distribute).
 *
 * 全部 endpoint 经 adminOnlyMiddleware 守 (role in {owner, admin}, 否则 403).
 *
 * 当前 endpoint:
 *   POST /admin/generate-article  — 单文章手动生成 (复用 createBatch)
 *   (POST /admin/generate-video 在 Day 2 上午加)
 *   (POST /admin/bulk-distribute + SSE 在 Day 2 下午加)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, gte, or } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals, contents, platformAccounts } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { adminOnlyMiddleware } from "../middleware/admin-only.js";
import { createBatch } from "../services/batch/batch-service.js";
import { recommendJournals } from "../services/recommendation/journal-recommender.js";
import { selectCandidates, DISCIPLINE_ROTATION, getJournal30dCount } from "../services/recommendation/daily-cron.js";
import { keywords as keywordsTable } from "../models/schema.js";
import { inArray } from "drizzle-orm";
import { triggerDvhFromArticle } from "../services/digital-human/article-bridge.js";
import { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId } from "../services/digital-human/template-mapping.js";
import { isRealMode } from "../services/digital-human/client.js";
import { bulkDistributeQueue, initBulkProgress, getBulkProgress, type BulkProgress } from "../services/bulk-distribute/queue.js";
import { contentPublishLog } from "../models/schema.js";
import { nanoid } from "nanoid";
import { logger } from "../config/logger.js";

// PR #173: "一键 N 篇" 模式 — count 替代 topic+journalId
const generateArticleSchema = z.object({
  count: z.number().int().min(1).max(20),
  template: z.enum(["A", "B", "C", "E"]).default("A"),
});

// PR #174: "一键生成发布" — 学科 + 数量 + 账号 + 可选发布
const generateAndPublishSchema = z.object({
  discipline: z.enum(["medicine", "psychology", "engineering", "economics", "biology", "education", "law", "agriculture", "computer", "environment", "chemistry", "physics", "auto"]).default("auto"),
  count: z.number().int().min(1).max(20).default(5),
  template: z.enum(["A", "B", "C", "E"]).default("A"),
  accountIds: z.array(z.string().uuid()).default([]), // 空数组 = 仅生成不发布
});

const generateVideoSchema = z.object({
  source: z.enum(["from_article", "from_topic"]),
  articleId: z.string().uuid().optional(),
  topic: z.string().min(2).max(100).optional(),
  avatarTemplate: z.enum(["A_academic", "B_marketing", "C_popular", "E_industry"]).default("A_academic"),
}).refine(
  (d) => (d.source === "from_article" ? !!d.articleId : !!d.topic),
  { message: "from_article 需 articleId; from_topic 需 topic" }
);

const bulkDistributeSchema = z.object({
  articleIds: z.array(z.string().uuid()).min(1).max(50),
  accountIds: z.array(z.string().uuid()).min(1).max(20),
  options: z.object({ throttleMs: z.number().int().min(0).max(60_000).default(3000) }).optional(),
});

const MAX_CARTESIAN = 200; // 笛卡尔积 safety cap

// 期刊 confidence 下限 (admin 生成时只用高质量期刊数据)
const MIN_JOURNAL_CONFIDENCE = 90;

export async function adminRoutes(app: FastifyInstance) {
  // 所有 /admin/* 路由先经 adminOnlyMiddleware
  app.addHook("preHandler", adminOnlyMiddleware);

  /**
   * POST /admin/generate-article  — PR #173 "一键 N 篇" 模式
   * body: { count: 1-20, template?: 'A'|'B'|'C'|'E' }
   * 返回: { batchIds: string[], estimatedSeconds: count*6 }
   *
   * 行为:
   *   1. selectCandidates (复用 daily-cron 多样性: cooldown + 学科 rotation + journal 30d 限流)
   *   2. recommendJournals top5 per keyword → 过 30d 限流 → 选 journal
   *   3. createBatch per keyword (priority=1)
   *   4. UPDATE keyword.last_recommended_at
   */
  app.post("/generate-article", async (request, reply) => {
    try {
      const body = generateArticleSchema.parse(request.body);
      const count = body.count;

      // 1. 选候选 keywords (复用 daily-cron 多样性逻辑)
      const dayOfWeek = new Date().getDay();
      const todayDisciplines = DISCIPLINE_ROTATION[dayOfWeek] ?? [];

      let candidates = await selectCandidates({
        disciplines: todayDisciplines.length > 0 ? todayDisciplines : null,
        cooldownDays: 30,
        poolSize: count * 5,
      });

      // Fallback: 学科放宽
      if (candidates.length < count && todayDisciplines.length > 0) {
        candidates = await selectCandidates({ disciplines: null, cooldownDays: 30, poolSize: count * 5 });
      }
      // Fallback: cooldown 放宽
      if (candidates.length < count) {
        candidates = await selectCandidates({ disciplines: null, cooldownDays: 14, poolSize: count * 5 });
      }
      // Fallback: 无 cooldown
      if (candidates.length < count) {
        candidates = await selectCandidates({ disciplines: null, cooldownDays: 0, poolSize: count * 5 });
      }

      if (candidates.length === 0) {
        return reply.code(400).send({ code: "NO_KEYWORDS", message: "无可用关键词, 请检查 keywords 抓取链路" });
      }

      // 2. 逐候选选 journal + 入队
      const batchIds: string[] = [];
      const selectedKeywordIds: string[] = [];
      const journalUseCount = new Map<string, number>();
      const MAX_PER_JOURNAL_24H = 2;
      const JOURNAL_MAX_PER_30D = 5;

      for (const kw of candidates) {
        if (batchIds.length >= count) break;
        try {
          const recs = await recommendJournals({
            tenantId: request.tenantId,
            topic: kw.keyword,
            limit: 5,
          });

          let journalId: string | null = null;
          for (const r of recs) {
            if ((journalUseCount.get(r.id) ?? 0) >= MAX_PER_JOURNAL_24H) continue;
            const use30d = await getJournal30dCount(r.id);
            if (use30d >= JOURNAL_MAX_PER_30D) continue;
            journalId = r.id;
            break;
          }
          if (!journalId) journalId = recs[0]?.id ?? null;
          if (journalId) journalUseCount.set(journalId, (journalUseCount.get(journalId) ?? 0) + 1);

          const result = await createBatch({
            tenantId: request.tenantId,
            userId: request.user.userId,
            filename: `manual-batch-${kw.keyword.slice(0, 20)}-${Date.now()}`,
            rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template: body.template, priority: 1 }],
          });
          batchIds.push(result.batchId);
          selectedKeywordIds.push(kw.id);
        } catch (err) {
          logger.warn({ keyword: kw.keyword, err }, "PR #173 单 keyword 入队失败 (跳过)");
        }
      }

      // 3. 更新 keyword.last_recommended_at
      if (selectedKeywordIds.length > 0) {
        await db
          .update(keywordsTable)
          .set({ lastRecommendedAt: new Date() })
          .where(inArray(keywordsTable.id, selectedKeywordIds));
      }

      logger.info(
        { count, enqueued: batchIds.length, template: body.template, userId: request.user.userId },
        "PR #173 admin generate-article 一键 N 篇入队"
      );

      return {
        code: "OK",
        data: {
          batchIds,
          estimatedSeconds: batchIds.length * 6,
        },
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #173 generate-article 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "生成失败, 请稍后重试" });
    }
  });

  /**
   * POST /admin/generate-and-publish — PR #174 "一键生成发布"
   * body: { discipline, count, template, accountIds }
   *
   * Chain: select keywords → create batches → return batchIds + progressId
   * 前端 poll batch status + 完成后可选 bulk-distribute
   */
  app.post("/generate-and-publish", async (request, reply) => {
    try {
      const body = generateAndPublishSchema.parse(request.body);
      const { count, template } = body;

      // 1. 学科选择
      let disciplines: string[] | null = null;
      if (body.discipline === "auto") {
        const dayOfWeek = new Date().getDay();
        const todayDisc = DISCIPLINE_ROTATION[dayOfWeek] ?? [];
        disciplines = todayDisc.length > 0 ? todayDisc : null;
      } else {
        disciplines = [body.discipline];
      }

      // 2. 选候选 keywords (复用 daily-cron 多样性)
      let candidates = await selectCandidates({
        disciplines,
        cooldownDays: 30,
        poolSize: count * 5,
      });
      if (candidates.length < count && disciplines) {
        candidates = await selectCandidates({ disciplines: null, cooldownDays: 30, poolSize: count * 5 });
      }
      if (candidates.length < count) {
        candidates = await selectCandidates({ disciplines: null, cooldownDays: 14, poolSize: count * 5 });
      }
      if (candidates.length < count) {
        candidates = await selectCandidates({ disciplines: null, cooldownDays: 0, poolSize: count * 5 });
      }

      if (candidates.length === 0) {
        return reply.code(400).send({ code: "NO_KEYWORDS", message: "无可用关键词" });
      }

      // 3. 逐候选选 journal + 入 batch
      const batchIds: string[] = [];
      const selectedKeywordIds: string[] = [];
      const journalUseCount = new Map<string, number>();

      for (const kw of candidates) {
        if (batchIds.length >= count) break;
        try {
          const recs = await recommendJournals({ tenantId: request.tenantId, topic: kw.keyword, limit: 5 });
          let journalId: string | null = null;
          for (const r of recs) {
            if ((journalUseCount.get(r.id) ?? 0) >= 2) continue;
            const use30d = await getJournal30dCount(r.id);
            if (use30d >= 5) continue;
            journalId = r.id;
            break;
          }
          if (!journalId) journalId = recs[0]?.id ?? null;
          if (journalId) journalUseCount.set(journalId, (journalUseCount.get(journalId) ?? 0) + 1);

          const result = await createBatch({
            tenantId: request.tenantId,
            userId: request.user.userId,
            filename: `auto-${kw.keyword.slice(0, 20)}-${Date.now()}`,
            rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template, priority: 1 }],
          });
          batchIds.push(result.batchId);
          selectedKeywordIds.push(kw.id);
        } catch (err) {
          logger.warn({ keyword: kw.keyword, err }, "PR #174 单 keyword 入队失败 (跳过)");
        }
      }

      // 4. 更新 keyword cooldown
      if (selectedKeywordIds.length > 0) {
        await db.update(keywordsTable).set({ lastRecommendedAt: new Date() }).where(inArray(keywordsTable.id, selectedKeywordIds));
      }

      logger.info(
        { count, enqueued: batchIds.length, discipline: body.discipline, template, accountIds: body.accountIds, userId: request.user.userId },
        "PR #174 generate-and-publish 入队"
      );

      return {
        code: "OK",
        data: {
          batchIds,
          accountIds: body.accountIds,
          estimatedSeconds: batchIds.length * 6,
        },
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #174 generate-and-publish 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "生成失败, 请稍后重试" });
    }
  });

  /**
   * POST /admin/generate-video
   * body: { source: 'from_article'|'from_topic', articleId?, topic?, avatarTemplate? }
   *
   * 双路径:
   *   from_article: 校验 articleId 存在 → triggerDvhFromArticle (复用 PR #140 链路)
   *                 返 { mode: 'direct', articleId, templateId, estimatedSeconds: 180 }
   *   from_topic:   createBatch 生成 article → 返 { mode: 'pending_article', batchId, templateId, estimatedSeconds: 240 }
   *                 client 后续 poll /batch/:id 拿 articleId, 自行调 POST /articles/:id/generate-dvh-video
   *                 (避免本 endpoint 长连阻塞 + 保 createBatch 与 dvh 解耦)
   */
  app.post("/generate-video", async (request, reply) => {
    try {
      const body = generateVideoSchema.parse(request.body);
      const templateId = body.avatarTemplate as TemplateId;
      if (!(templateId in TEMPLATE_AVATAR_VOICE_MAP)) {
        return reply.code(400).send({ code: "BAD_TEMPLATE", message: `avatarTemplate 非法: ${templateId}` });
      }
      if (isRealMode() && (!process.env.DVH_TENANT_ID || !process.env.DVH_APP_ID)) {
        return reply.code(503).send({ code: "NO_DVH", message: "DVH_REAL_MODE=true 但 DVH 凭证缺失" });
      }

      if (body.source === "from_article" && body.articleId) {
        // 路径 A: 现有 article 直接生成视频 (复用 PR #140)
        const [article] = await db
          .select()
          .from(contents)
          .where(and(
            eq(contents.id, body.articleId),
            or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
          ))
          .limit(1);
        if (!article || article.type !== "article") {
          return reply.code(404).send({ code: "NOT_FOUND", message: "article 不存在" });
        }
        void triggerDvhFromArticle({
          db,
          tenantId: request.tenantId,
          userId: request.user.userId,
          articleContentId: article.id,
          templateId,
          conversationId: article.conversationId ?? null,
          journalId: (article.metadata as { journalId?: string } | null)?.journalId,
        });
        logger.info({ articleId: body.articleId, templateId, realMode: isRealMode() }, "PR #161 admin generate-video (from_article)");
        return {
          code: "OK",
          data: { mode: "direct", articleId: body.articleId, templateId, estimatedSeconds: 180 },
        };
      }

      // 路径 B: from_topic, 先生成 article (top1 推荐期刊, 模板 A)
      const recs = await recommendJournals({ tenantId: request.tenantId, topic: body.topic!, limit: 1 });
      const journalId = recs[0]?.id;
      if (!journalId) {
        return reply.code(400).send({ code: "NO_JOURNAL_MATCH", message: `无法为 topic '${body.topic}' 匹配期刊` });
      }
      const filename = `manual-video-${body.topic!.slice(0, 20)}-${Date.now()}`;
      const result = await createBatch({
        tenantId: request.tenantId,
        userId: request.user.userId,
        filename,
        rows: [{ rowIndex: 1, topic: body.topic!, journalId, template: "A", priority: 1 }],
      });
      logger.info({ batchId: result.batchId, topic: body.topic, templateId }, "PR #161 admin generate-video (from_topic) batch 已入队");
      return {
        code: "OK",
        data: {
          mode: "pending_article",
          batchId: result.batchId,
          templateId,
          estimatedSeconds: 240, // 60s article + 180s video
        },
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #161 generate-video 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "视频生成请求失败" });
    }
  });

  /**
   * POST /admin/bulk-distribute
   * body: { articleIds: uuid[], accountIds: uuid[], options?: {throttleMs: 3000} }
   * 返回: { batchId, total, skipped, queued }
   *
   * 流程:
   *   1. 笛卡尔积 (articleIds × accountIds), 验 ≤ 200 防滥用
   *   2. SELECT content_publish_log WHERE (cid, aid) in (...) AND status='success'
   *      已成功的 → INSERT 'skipped' log + 算 progress
   *   3. 剩余对入 bulkDistributeQueue (throttleMs delay 累加)
   *   4. 返回 batchId + 三类计数, 客户端 SSE /bulk-distribute/:batchId/stream 拿进度
   */
  app.post("/bulk-distribute", async (request, reply) => {
    try {
      const body = bulkDistributeSchema.parse(request.body);
      const pairs: Array<{ contentId: string; accountId: string }> = [];
      for (const cid of body.articleIds) {
        for (const aid of body.accountIds) {
          pairs.push({ contentId: cid, accountId: aid });
        }
      }
      if (pairs.length > MAX_CARTESIAN) {
        return reply.code(400).send({
          code: "TOO_MANY_PAIRS",
          message: `笛卡尔积 ${pairs.length} > ${MAX_CARTESIAN} 上限, 减少 articles 或 accounts`,
        });
      }

      // 2. 查已成功的 (cid, aid) 对 — 直接 raw sql IN tuple match
      const tupleList = pairs.map((p) => `(${escapeUuid(p.contentId)}::uuid, ${escapeUuid(p.accountId)}::uuid)`).join(",");
      const existingResult = await db.execute(
        sqlRaw(`SELECT content_id, account_id FROM content_publish_log WHERE status = 'success' AND (content_id, account_id) IN (${tupleList})`)
      );
      const existing = new Set(
        ((existingResult as any).rows as Array<{ content_id: string; account_id: string }>).map(
          (r) => `${r.content_id}|${r.account_id}`
        )
      );

      const batchId = `bd-${nanoid(10)}`;
      const skippedPairs = pairs.filter((p) => existing.has(`${p.contentId}|${p.accountId}`));
      const queuedPairs = pairs.filter((p) => !existing.has(`${p.contentId}|${p.accountId}`));

      // 3. INSERT skipped log (ON CONFLICT update updated_at — 不破坏已有 success)
      if (skippedPairs.length > 0) {
        const skippedValues = skippedPairs
          .map(
            (p) =>
              `(${escapeUuid(request.tenantId)}::uuid, ${escapeUuid(p.contentId)}::uuid, ${escapeUuid(p.accountId)}::uuid, 'skipped', NULL, 'duplicate', 'bulk_distribute', ${escapeUuid(request.user.userId)}::uuid)`
          )
          .join(",");
        await db.execute(
          sqlRaw(`INSERT INTO content_publish_log (tenant_id, content_id, account_id, status, media_id, error_message, initiated_by, initiated_user_id) VALUES ${skippedValues} ON CONFLICT (content_id, account_id) DO UPDATE SET updated_at = NOW()`)
        );
      }

      // 4. init progress + 入 queue
      initBulkProgress(batchId, pairs.length, skippedPairs.length);
      const throttleMs = body.options?.throttleMs ?? 3000;
      for (let i = 0; i < queuedPairs.length; i++) {
        const p = queuedPairs[i]!;
        await bulkDistributeQueue.add(
          "bulk-job",
          { batchId, contentId: p.contentId, accountId: p.accountId, tenantId: request.tenantId, userId: request.user.userId },
          { delay: i * throttleMs, jobId: `${batchId}-${p.contentId}-${p.accountId}` }
        );
      }

      logger.info(
        { batchId, total: pairs.length, skipped: skippedPairs.length, queued: queuedPairs.length, throttleMs, userId: request.user.userId },
        "PR #161 bulk-distribute 入队"
      );

      return {
        code: "OK",
        data: { batchId, total: pairs.length, skipped: skippedPairs.length, queued: queuedPairs.length },
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #161 bulk-distribute 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "批量发布请求失败" });
    }
  });

  /**
   * GET /admin/bulk-distribute/:batchId/stream — SSE 进度推送
   * events:
   *   progress: { batchId, total, completed, success, failed, skipped, lastFailed? }
   *   done:     { batchId, success, failed, skipped, durationMs }
   * 心跳每 15s `: ping\n\n` 防中间件超时断连.
   */
  app.get("/bulk-distribute/:batchId/stream", async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const progress = getBulkProgress(batchId);
    if (!progress) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "batch 不存在或已过期 (10 分钟)" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 推第一帧
    sendEvent("progress", serializeProgress(progress));
    if (progress.finishedAt) {
      sendEvent("done", {
        batchId,
        success: progress.success,
        failed: progress.failed,
        skipped: progress.skipped,
        durationMs: progress.finishedAt - progress.startedAt,
      });
      reply.raw.end();
      return;
    }

    // 订阅 progress 更新
    const onUpdate = (p: BulkProgress) => {
      sendEvent("progress", serializeProgress(p));
      if (p.finishedAt) {
        sendEvent("done", {
          batchId,
          success: p.success,
          failed: p.failed,
          skipped: p.skipped,
          durationMs: p.finishedAt - p.startedAt,
        });
        cleanup();
        reply.raw.end();
      }
    };
    progress.subscribers.add(onUpdate);

    // 心跳防中间件超时
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    const cleanup = () => {
      progress.subscribers.delete(onUpdate);
      clearInterval(heartbeat);
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);

    // fastify 异步 handler 默认会自动 reply, 这里手动 hijack
    return reply;
  });
}

// 工具: UUID 安全转义 (regex 校验 + 直接 inline, 避免 prepared statement 复杂度)
function escapeUuid(uuid: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) throw new Error(`非法 UUID: ${uuid}`);
  return `'${uuid}'`;
}

// drizzle sql 模板裸字符串 (因 IN tuple list 无法用参数化, 已 escapeUuid 防注入)
import { sql as drizzleSql } from "drizzle-orm";
function sqlRaw(s: string) {
  return drizzleSql.raw(s);
}

function serializeProgress(p: BulkProgress) {
  return {
    batchId: p.batchId,
    total: p.total,
    completed: p.completed,
    success: p.success,
    failed: p.failed,
    skipped: p.skipped,
    lastFailed: p.lastFailed,
  };
}

// 防 unused
void contentPublishLog;
