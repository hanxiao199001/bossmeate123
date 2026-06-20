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
import { eq, and, gte, or, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals, contents, platformAccounts, tenants, journalUsage } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { adminOnlyMiddleware } from "../middleware/admin-only.js";
import { createBatch } from "../services/batch/batch-service.js";
import { recommendJournals } from "../services/recommendation/journal-recommender.js";
import { selectCandidates, DISCIPLINE_ROTATION, getJournal30dCount } from "../services/recommendation/daily-cron.js";
import { splitAlreadyPublished } from "../services/bulk-distribute/dedup.js";
import { ALL_DISCIPLINES } from "../services/content-engine/topic-recommender.js";
import { keywords as keywordsTable } from "../models/schema.js";
import { inArray } from "drizzle-orm";
import { triggerDvhFromArticle } from "../services/digital-human/article-bridge.js";
import { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId } from "../services/digital-human/template-mapping.js";
import { isRealMode } from "../services/digital-human/client.js";
import { bulkDistributeQueue, initBulkProgress, getBulkProgress, type BulkProgress } from "../services/bulk-distribute/queue.js";
import { contentPublishLog } from "../models/schema.js";
import { nanoid } from "nanoid";
import { logger } from "../config/logger.js";
import { initialStatusFields } from "../services/articles/state-machine.js";
import { generateRoundupArticle } from "../services/content-engine/roundup-generator.js";

// PR #173: "一键 N 篇" 模式 — count 替代 topic+journalId
const generateArticleSchema = z.object({
  count: z.number().int().min(1).max(20),
  template: z.enum(["A", "B", "C", "E"]).default("A"),
});

// PR #174: "一键生成发布" — 学科 + 数量 + 账号 + 可选发布
// PR #174 + PR #175: 一键生成发布 (快速 + 精准两种模式)
const generateAndPublishSchema = z.object({
  mode: z.enum(["discipline-auto", "journal-specified"]).default("discipline-auto"),
  // discipline-auto 模式参数
  discipline: z.enum(["medicine", "psychology", "engineering", "economics", "biology", "education", "law", "agriculture", "computer", "environment", "chemistry", "physics", "auto"]).default("auto"),
  count: z.number().int().min(1).max(20).default(5),
  // journal-specified 模式参数
  journalIds: z.array(z.string().uuid()).default([]),
  // 通用
  template: z.enum(["A", "B", "C", "E"]).default("A"),
  // PR-Q2: 排版模板 (顺仕美途/数据卡片/故事/清单), 缺省=不指定走默认; "rotate"=随机轮换
  layoutTemplateId: z.enum(["shunshi-style", "data-card", "storytelling", "listicle", "rotate"]).optional(),
  accountIds: z.array(z.string().uuid()).default([]),
  // PR-W5: exclusive=每账号按自己领域生成专属内容(count=每账号篇数, 互不重复); broadcast=老行为
});

// PR #175: 期刊筛选 query schema
const journalSearchSchema = z.object({
  name: z.string().optional(),
  issn: z.string().optional(),
  discipline: z.string().optional(),
  ifMin: z.coerce.number().optional(),
  ifMax: z.coerce.number().optional(),
  jcrSubject: z.string().optional(),
  wosLevel: z.enum(["all", "scie", "ssci"]).default("all"),
  catalog: z.enum(["pku-core", "cssci", "cssci-ext", "cscd", "sci-core"]).optional(), // PR-C2 中文核心目录
  sortBy: z.enum(["if_desc", "if_asc", "name"]).default("if_desc"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const generateVideoSchema = z.object({
  source: z.enum(["from_article", "from_topic"]),
  articleId: z.string().uuid().optional(),
  topic: z.string().min(2).max(100).optional(),
  avatarTemplate: z.string().min(1).max(40).default("A_academic"), // 6-19 放开: 支持目录扩展的自定义形象key(接口用 resolveAvatarVoice 校验)
}).refine(
  (d) => (d.source === "from_article" ? !!d.articleId : !!d.topic),
  { message: "from_article 需 articleId; from_topic 需 topic" }
);

const bulkDistributeSchema = z.object({
  // 传 pairs = 精确配对模式 (PR-W5 exclusive: 每文只发自己的账号); 否则 articleIds×accountIds 笛卡尔积
  articleIds: z.array(z.string().uuid()).max(50).default([]),
  accountIds: z.array(z.string().uuid()).max(20).default([]),
  pairs: z.array(z.object({ articleId: z.string().uuid(), accountId: z.string().uuid() })).max(200).optional(),
  options: z.object({ throttleMs: z.number().int().min(0).max(60_000).default(3000) }).optional(),
});

const MAX_CARTESIAN = 200; // 笛卡尔积 safety cap

// PR-Q2: 排版模板解析 — 指定id直接用; "rotate"或缺省→随机轮换4个真排版模板; 让用户能手动选排版
const LAYOUT_POOL = ["shunshi-style", "data-card", "storytelling", "listicle"];
function resolveLayout(v?: string): string | undefined {
  if (!v || v === "rotate") return LAYOUT_POOL[Math.floor(Math.random() * LAYOUT_POOL.length)];
  return v;
}

// 期刊 confidence 下限 (admin 生成时只用高质量期刊数据)
const MIN_JOURNAL_CONFIDENCE = 90;

export async function adminRoutes(app: FastifyInstance) {
  // 5-19 PR #171: 权限分级 — 删全局 addHook, 改 per-route preHandler
  // generate-article/video: 任 authenticated user (单文章生成无破坏)
  // bulk-distribute / SSE: admin only (大批量影响外部 API, 跨多文章)

  /**
   * GET /admin/journals/search — PR #175 期刊实时筛选
   * 从 DB 39+ 期刊中按 7 条件筛选, 返回匹配列表
   */
  app.get("/journals/search", async (request, reply) => {
    try {
      const q = journalSearchSchema.parse(request.query);
      // PR-C2: 选了核心目录时放宽 confidence 门槛 (中文核心刊 conf=55, 目录归属本身即权威背书)
      const conditions: string[] = [q.catalog ? "confidence >= 50" : "confidence >= 70"];

      if (q.name) conditions.push(`(name_en ILIKE '%${q.name.replace(/'/g, "''")}%' OR name ILIKE '%${q.name.replace(/'/g, "''")}%')`);
      if (q.issn) conditions.push(`issn = '${q.issn.replace(/'/g, "''")}'`);
      if (q.discipline) conditions.push(`discipline = '${q.discipline.replace(/'/g, "''")}'`);
      if (q.ifMin != null) conditions.push(`impact_factor >= ${Number(q.ifMin)}`);
      if (q.ifMax != null) conditions.push(`impact_factor <= ${Number(q.ifMax)}`);
      if (q.jcrSubject) conditions.push(`jcr_full::text ILIKE '%${q.jcrSubject.replace(/'/g, "''")}%'`);
      if (q.wosLevel === "scie") conditions.push(`jcr_full->>'wosLevel' = 'SCIE'`);
      if (q.wosLevel === "ssci") conditions.push(`jcr_full->>'wosLevel' = 'SSCI'`);
      if (q.catalog) conditions.push(`catalogs @> '["${q.catalog}"]'::jsonb`);

      const orderBy = q.sortBy === "if_asc" ? "impact_factor ASC NULLS LAST"
        : q.sortBy === "name" ? "name_en ASC"
        : "impact_factor DESC NULLS LAST";

      const where = conditions.join(" AND ");
      const countResult = await db.execute(sql`SELECT COUNT(*)::int AS total FROM journals WHERE ${sql.raw(where)}`);
      const total = (countResult as any).rows?.[0]?.total ?? 0;

      const rows = await db.execute(sql`
        SELECT id, name, name_en, issn, impact_factor, partition, discipline,
               acceptance_rate, review_cycle, apc_fee, is_warning_list,
               pku_core_level, cscd_level, catalogs,
               jcr_full->>'wosLevel' AS wos_level, confidence
        FROM journals WHERE ${sql.raw(where)}
        ORDER BY ${sql.raw(orderBy)}
        LIMIT ${q.limit}
      `);

      return { code: "OK", data: { items: (rows as any).rows, total } };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR #175 journals/search 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "搜索失败" });
    }
  });

  /**
   * POST /admin/generate-article — PR #173 "一键 N 篇" + PR #171 全 user 可调
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
      const MAX_PER_JOURNAL_24H = 1; // PR #180: batch 内每期刊最多 1 篇
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
      const { template } = body;
      const batchIds: string[] = [];
      const selectedKeywordIds: string[] = [];

      if (body.mode === "journal-specified" && body.journalIds.length > 0) {
        // PR #175: 精准模式 — 用户指定 journalIds, 每个 journal 选 1 个 fresh keyword
        for (const jid of body.journalIds) {
          // 查 journal discipline → 选该学科 fresh keyword
          const [j] = await db.select({ discipline: journals.discipline }).from(journals).where(eq(journals.id, jid)).limit(1);
          const disc = j?.discipline ? [j.discipline] : null;
          const kws = await selectCandidates({ disciplines: disc, cooldownDays: 30, poolSize: 5 });
          // fallback: 全学科
          const kwPool = kws.length > 0 ? kws : await selectCandidates({ disciplines: null, cooldownDays: 0, poolSize: 5 });
          const kw = kwPool[0];
          if (!kw) continue;

          try {
            const result = await createBatch({
              tenantId: request.tenantId,
              userId: request.user.userId,
              filename: `precise-${kw.keyword.slice(0, 20)}-${Date.now()}`,
              rows: [{ rowIndex: 1, topic: kw.keyword, journalId: jid, template, priority: 1 }],
            });
            batchIds.push(result.batchId);
            selectedKeywordIds.push(kw.id);
          } catch (err) {
            logger.warn({ journalId: jid, err }, "PR #175 journal-specified 入队失败 (跳过)");
          }
        }
      } else {
        // PR #174: 快速模式 — discipline-auto
        const count = body.count;
        let disciplines: string[] | null = null;
        if (body.discipline === "auto") {
          const dayOfWeek = new Date().getDay();
          const todayDisc = DISCIPLINE_ROTATION[dayOfWeek] ?? [];
          disciplines = todayDisc.length > 0 ? todayDisc : null;
        } else {
          disciplines = [body.discipline];
        }

        let candidates = await selectCandidates({ disciplines, cooldownDays: 30, poolSize: count * 5 });
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

        const journalUseCount = new Map<string, number>();
        for (const kw of candidates) {
          if (batchIds.length >= count) break;
          try {
            const recs = await recommendJournals({ tenantId: request.tenantId, topic: kw.keyword, limit: 5 });
            let journalId: string | null = null;
            for (const r of recs) {
              // PR #180: batch 内每期刊最多 1 篇 (5 篇 → 5 不同期刊)
              if ((journalUseCount.get(r.id) ?? 0) >= 1) continue;
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
              rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template, templateId: resolveLayout(body.layoutTemplateId), priority: 1 }],
            });
            batchIds.push(result.batchId);
            selectedKeywordIds.push(kw.id);
          } catch (err) {
            logger.warn({ keyword: kw.keyword, err }, "PR #174 单 keyword 入队失败 (跳过)");
          }
        }
      }

      // 更新 keyword cooldown
      if (selectedKeywordIds.length > 0) {
        await db.update(keywordsTable).set({ lastRecommendedAt: new Date() }).where(inArray(keywordsTable.id, selectedKeywordIds));
      }

      logger.info(
        { mode: body.mode, enqueued: batchIds.length, template, userId: request.user.userId },
        "PR #175 generate-and-publish 入队"
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
      logger.error({ err }, "PR #175 generate-and-publish 失败");
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
      // PR-X2: 目录解析 (支持扩展形象)
      const { resolveAvatarVoice } = await import("../services/digital-human/template-mapping.js");
      if (!(await resolveAvatarVoice(templateId))) {
        return reply.code(400).send({ code: "BAD_TEMPLATE", message: `avatarTemplate 不在形象目录中: ${templateId}` });
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
   * POST /admin/smart-assign {articleIds, accountIds?} — PR-W6 智能配对预览
   * 按"文章学科↔账号领域"配对(每篇一个号, 负载均衡), 返回 pairs 供 bulk-distribute 精确发布。
   */
  app.post("/smart-assign", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    try {
      const body = z.object({
        articleIds: z.array(z.string().uuid()).min(1).max(50),
        accountIds: z.array(z.string().uuid()).max(20).optional(),
      }).parse(request.body);
      const { computeSmartPairs } = await import("../services/publisher/smart-assign.js");
      const result = await computeSmartPairs({ tenantId: request.tenantId, articleIds: body.articleIds, accountIds: body.accountIds });
      return { code: "OK", data: result };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: err.errors[0]?.message ?? "参数错误" });
      }
      logger.error({ err }, "PR-W6 smart-assign 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "配对失败" });
    }
  });

  /**
   * POST /admin/auto-distribute/preview — 立即配对预览(= 把每天 07:00 自动分发现在算一遍, 不入队)。
   * 取今日池(本租户自有当日生成 → 无则系统池) → computeSmartPairs(按账号定位+领域配对) →
   * splitAlreadyPublished 标注已发过的。返回带 标题/账号名 的 fresh/skipped/unmatched 供前端弹窗。
   * 确认分发由前端拿 fresh 调 /admin/bulk-distribute {pairs} (同一套去重, 幂等)。
   */
  app.post("/auto-distribute/preview", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    try {
      const BJ = 8 * 3600_000;
      const bj = new Date(Date.now() + BJ); bj.setUTCHours(0, 0, 0, 0);
      const startToday = new Date(bj.getTime() - BJ);
      const todayGenerated = (tid: string) => db.select({ id: contents.id })
        .from(contents)
        .where(and(eq(contents.tenantId, tid), eq(contents.type, "article"), gte(contents.createdAt, startToday), eq(contents.status, "generated")))
        .limit(100);
      let pool = await todayGenerated(request.tenantId);
      let poolSource = "tenant";
      if (pool.length === 0) { pool = await todayGenerated(SYSTEM_RECOMMENDATION_TENANT_ID); poolSource = "system"; }
      const articleIds = pool.map((r) => r.id);
      if (articleIds.length === 0) {
        return { code: "OK", data: { poolSource, poolSize: 0, fresh: [], skipped: [], unmatched: [], freshCount: 0, skippedCount: 0 } };
      }
      const { computeSmartPairs } = await import("../services/publisher/smart-assign.js");
      const { pairs, unmatched } = await computeSmartPairs({ tenantId: request.tenantId, articleIds });
      const { fresh, skipped } = await splitAlreadyPublished(
        pairs.map((p) => ({ contentId: p.articleId, accountId: p.accountId, discipline: p.discipline })),
      );
      // 富化: 标题(全池, 含 unmatched) + 账号名
      const titleMap = new Map<string, string>();
      (await db.select({ id: contents.id, title: contents.title }).from(contents).where(inArray(contents.id, articleIds)))
        .forEach((r) => titleMap.set(r.id, r.title ?? "(无标题)"));
      const aids = [...new Set(pairs.map((p) => p.accountId))];
      const nameMap = new Map<string, string>();
      if (aids.length > 0) {
        (await db.select({ id: platformAccounts.id, accountName: platformAccounts.accountName }).from(platformAccounts).where(inArray(platformAccounts.id, aids)))
          .forEach((r) => nameMap.set(r.id, r.accountName));
      }
      const enrich = (arr: Array<{ contentId: string; accountId: string; discipline: string | null }>) =>
        arr.map((p) => ({ contentId: p.contentId, accountId: p.accountId, title: titleMap.get(p.contentId) ?? "", accountName: nameMap.get(p.accountId) ?? "(未知账号)", discipline: p.discipline ?? null }));
      return { code: "OK", data: {
        poolSource, poolSize: articleIds.length,
        fresh: enrich(fresh), skipped: enrich(skipped),
        freshCount: fresh.length, skippedCount: skipped.length,
        unmatched: unmatched.map((u) => ({ contentId: u.articleId, title: titleMap.get(u.articleId) ?? "", reason: u.reason })),
      } };
    } catch (err) {
      logger.error({ err }, "auto-distribute preview 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "配对预览失败" });
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
  // 5-19 PR #171: bulk-distribute admin only (大批量影响外部 API + 笛卡尔积 ≤ 200, 防滥用)
  app.post("/bulk-distribute", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    try {
      const body = bulkDistributeSchema.parse(request.body);
      const pairs: Array<{ contentId: string; accountId: string }> = [];
      if (body.pairs && body.pairs.length > 0) {
        // PR-W5 精确配对: 每文只发指定账号 (exclusive 一键链路)
        for (const p of body.pairs) pairs.push({ contentId: p.articleId, accountId: p.accountId });
      } else {
        if (body.articleIds.length === 0 || body.accountIds.length === 0) {
          return reply.code(400).send({ code: "BAD_REQUEST", message: "需提供 pairs 或 articleIds+accountIds" });
        }
        for (const cid of body.articleIds) {
          for (const aid of body.accountIds) {
            pairs.push({ contentId: cid, accountId: aid });
          }
        }
      }
      if (pairs.length > MAX_CARTESIAN) {
        return reply.code(400).send({
          code: "TOO_MANY_PAIRS",
          message: `笛卡尔积 ${pairs.length} > ${MAX_CARTESIAN} 上限, 减少 articles 或 accounts`,
        });
      }

      // 2. 去重 — 与自动分发共用 splitAlreadyPublished (剔除已成功发过的 content×account)
      const { fresh: queuedPairs, skipped: skippedPairs } = await splitAlreadyPublished(pairs);
      const batchId = `bd-${nanoid(10)}`;

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
  /**
   * GET /admin/bulk-distribute/:batchId — 进度状态 (轮询用).
   * PR #219: SSE 的 EventSource 不能带 Authorization 头, 而 @fastify/jwt 只认 Bearer 头,
   *   导致 SSE 必 401 断连("SSE 连接断开")。改用普通 GET + 前端轮询: 走 api 客户端带 Bearer 头, 稳定。
   */
  app.get("/bulk-distribute/:batchId", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const progress = getBulkProgress(batchId);
    if (!progress) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "batch 不存在或已过期 (10 分钟)" });
    }
    const finished = !!progress.finishedAt;
    return {
      code: "OK",
      data: {
        ...serializeProgress(progress),
        finished,
        durationMs: finished ? progress.finishedAt! - progress.startedAt : null,
      },
    };
  });

  /**
   * PR #223: 每日推荐配置 — 每学科篇数 (dailyQuota).
   *   存 SYSTEM 租户 config.automationConfig.dailyQuota. daily-cron 据此选刊 (PR #222).
   *   GET 返回当前配额 + 全学科列表(供 UI); PATCH 写入(校验学科 code + 单学科≤50 + 总数≤100).
   */
  app.get("/daily-recommendation-config", { preHandler: adminOnlyMiddleware }, async () => {
    const [t] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID))
      .limit(1);
    const quota = (t?.config as { automationConfig?: { dailyQuota?: Record<string, number> } } | null)?.automationConfig?.dailyQuota;
    return { code: "OK", data: { quota: quota || {}, disciplines: ALL_DISCIPLINES } };
  });

  app.patch("/daily-recommendation-config", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body as { quota?: Record<string, unknown> } | null) || {};
    const validCodes = new Set<string>(ALL_DISCIPLINES.map((d) => d.code));
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.quota || {})) {
      if (!validCodes.has(k)) continue; // 只接受已知学科 code
      const n = Math.floor(Number(v));
      if (Number.isFinite(n) && n > 0) clean[k] = Math.min(n, 50); // 单学科上限 50 防滥用
    }
    const total = Object.values(clean).reduce((a, b) => a + b, 0);
    if (total > 100) {
      return reply.code(400).send({ code: "QUOTA_TOO_LARGE", message: `每日总数 ${total} 超上限 100` });
    }
    const [t] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID))
      .limit(1);
    const cfg = (t?.config as Record<string, unknown>) || {};
    const auto = (cfg.automationConfig as Record<string, unknown>) || {};
    cfg.automationConfig = { ...auto, dailyQuota: clean };
    await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID));
    // 设置变更 → 失效今日选题推荐缓存, 下次查看按新学科重算 (与每日内容设置同源)
    try { const { invalidateTodayRecommendations } = await import("../services/content-engine/topic-recommender.js"); await invalidateTodayRecommendations(); } catch (err) { logger.warn({ err: String(err) }, "失效今日推荐缓存失败(不影响保存)"); }
    logger.info({ quota: clean, total }, "PR #223 每日推荐配额已更新");
    return { code: "OK", data: { quota: clean, total } };
  });

  /**
   * PR-O: 每日内容配置(按类型) — domestic/international/roundup 各 {count, disciplines}。
   *   数字人暂不自动生成。存 SYSTEM 租户 config.automationConfig.contentQuota, daily-cron 据此分类型生成。
   */
  app.get("/daily-content-config", { preHandler: adminOnlyMiddleware }, async () => {
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const cq = (t?.config as { automationConfig?: { contentQuota?: any } } | null)?.automationConfig?.contentQuota;
    return { code: "OK", data: { contentQuota: cq || {}, disciplines: ALL_DISCIPLINES } };
  });
  app.patch("/daily-content-config", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body as { contentQuota?: Record<string, { count?: unknown; disciplines?: unknown }> } | null) || {};
    const validTypes = new Set(["domestic", "international", "roundup", "topicPool"]); // PR-V1 跨行业选题池
    const validDisc = new Set<string>(ALL_DISCIPLINES.map((d) => d.code));
    const clean: Record<string, { count: number; disciplines: string[] }> = {};
    let total = 0;
    for (const [type, v] of Object.entries(body.contentQuota || {})) {
      if (!validTypes.has(type)) continue;
      const count = Math.min(Math.max(Math.floor(Number(v?.count)) || 0, 0), 50);
      const disciplines = Array.isArray(v?.disciplines)
        ? (v!.disciplines as unknown[]).map(String).filter((d) => validDisc.has(d))
        : [];
      if (count > 0) { clean[type] = { count, disciplines }; total += count; }
    }
    if (total > 100) return reply.code(400).send({ code: "QUOTA_TOO_LARGE", message: `每日总数 ${total} 超上限 100` });
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const cfg = (t?.config as Record<string, unknown>) || {};
    const auto = (cfg.automationConfig as Record<string, unknown>) || {};
    cfg.automationConfig = { ...auto, contentQuota: clean };
    await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID));
    // 设置变更 → 失效今日选题推荐缓存, 下次查看按新学科重算
    try { const { invalidateTodayRecommendations } = await import("../services/content-engine/topic-recommender.js"); await invalidateTodayRecommendations(); } catch (err) { logger.warn({ err: String(err) }, "失效今日推荐缓存失败(不影响保存)"); }
    logger.info({ contentQuota: clean, total }, "PR-O 每日内容配置(按类型)已更新");
    return { code: "OK", data: { contentQuota: clean, total } };
  });

  /**
   * PR-X2: DVH 形象目录 — 默认4个 + 管理员扩展 (从阿里云控制台拿真实 avatarCode/voiceCode 后添加)。
   * GET 给前端主播选择器; PATCH 整体替换扩展条目 (存 SYSTEM config.automationConfig.dvhCatalog)。
   */
  // 6-19: 从阿里云拉取账号下可用形象(给前端目录管理选用; 尤其加男形象防查重)。
  app.get("/dvh-avatars", { preHandler: adminOnlyMiddleware }, async (_req, reply) => {
    try {
      const { listDvhAvatars } = await import("../services/digital-human/list-avatars.js");
      return { code: "OK", data: { avatars: await listDvhAvatars() } };
    } catch (err) {
      logger.error({ err }, "拉取阿里云形象失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: `拉取阿里云形象失败: ${err instanceof Error ? err.message : "未知错误"}` });
    }
  });
  // 6-19 AI 混剪 MVP: 对一条视频内容做混剪, 返回新视频URL(先验证出片; 落库变体/按账号分发为下一步)。
  app.post("/videos/:id/remix", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const rb = (request.body as { seed?: number; cta?: string } | null) || {};
      const [c] = await db.select({ id: contents.id, title: contents.title, body: contents.body })
        .from(contents).where(eq(contents.id, id)).limit(1);
      if (!c) return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      const raw = String(c.body || "");
      const videoUrl = /(https?:\/\/[^\s"\'<>]+\.mp4[^\s"\'<>]*)/i.exec(raw)?.[1]
        || /(\/storage\/[^\s"\'<>]+\.mp4)/i.exec(raw)?.[1]
        || (/\.mp4/i.test(raw) ? raw.trim() : "");
      if (!videoUrl) return reply.code(400).send({ code: "NO_VIDEO", message: "该内容不是视频或找不到视频地址" });
      const { remixVideo } = await import("../services/digital-human/video-remix.js");
      const seed = Number.isFinite(rb.seed) ? Number(rb.seed) : undefined;
      const result = await remixVideo({ videoUrl, title: c.title || "", cta: rb.cta, taskUuid: `c${String(id).slice(0, 8)}`, seed });
      if (!result.remixed) return reply.code(502).send({ code: "REMIX_FAILED", message: "混剪失败(已回退原视频), 看服务端日志 dvh.remix.failed_fallback(多半是字体路径或2核4G超时)" });
      return { code: "OK", data: { videoUrl: result.videoUrl, remixed: true } };
    } catch (err) {
      logger.error({ err }, "混剪端点失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "混剪失败" });
    }
  });
  app.get("/dvh-catalog", async () => {
    const { loadDvhCatalog } = await import("../services/digital-human/template-mapping.js");
    return { code: "OK", data: { catalog: await loadDvhCatalog() } };
  });
  app.patch("/dvh-catalog", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body ?? {}) as { entries?: unknown[] };
    if (!Array.isArray(body.entries) || body.entries.length > 50) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "entries 须为数组(≤50)" });
    }
    const clean = body.entries
      .map((e) => e as Record<string, unknown>)
      .filter((e) => typeof e.key === "string" && e.key && typeof e.avatarCode === "string" && e.avatarCode && typeof e.voiceCode === "string" && e.voiceCode)
      .map((e) => ({
        key: String(e.key).slice(0, 40),
        avatarCode: String(e.avatarCode).slice(0, 100),
        avatarLabel: String(e.avatarLabel || e.key).slice(0, 60),
        voiceCode: String(e.voiceCode).slice(0, 60),
        voiceLabel: String(e.voiceLabel || e.voiceCode).slice(0, 60),
        templateLabel: String(e.templateLabel || e.key).slice(0, 60),
        ...(typeof e.backgroundUrl === "string" && e.backgroundUrl ? { backgroundUrl: e.backgroundUrl.slice(0, 500) } : {}),
      }));
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const cfg = (t?.config as Record<string, unknown>) || {};
    const auto = (cfg.automationConfig as Record<string, unknown>) || {};
    cfg.automationConfig = { ...auto, dvhCatalog: clean };
    await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID));
    logger.info({ count: clean.length }, "PR-X2 DVH 形象目录已更新");
    return { code: "OK", data: { entries: clean } };
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // PR-Z4

  /**
   * PR-Y1: 企业画像链路 (跨行业客户开通) — 三步:
   *   1. POST /admin/onboarding/profile {materials[], questionnaire?} → 提炼画像存 tenant config
   *   2. POST /admin/onboarding/derive-accounts {overwrite?} → 每号角色定位+persona 回写
   *   3. POST /admin/onboarding/topic-pool {count?} → 选题池入 keywords (tenant 私有)
   * 注: 作用于"调用者自己的租户" — 给客户开通时用客户租户的 admin 身份调用。
   */
  app.post("/onboarding/profile", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body ?? {}) as { materials?: unknown[]; questionnaire?: Record<string, string> };
    const materials = (Array.isArray(body.materials) ? body.materials : [])
      .map(String).map((m) => m.trim()).filter((m) => m.length >= 50).slice(0, 10);
    if (materials.length === 0) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "至少提供 1 段 ≥50 字的公司资料 (官网/产品介绍/历史文章)" });
    }
    try {
      const { extractCompanyProfile } = await import("../services/onboarding/company-profile.js");
      const profile = await extractCompanyProfile({
        tenantId: request.tenantId, userId: request.user.userId,
        materials, questionnaire: body.questionnaire,
      });
      return { code: "OK", data: { profile } };
    } catch (err) {
      logger.error({ err }, "PR-Y1 画像提炼失败");
      return reply.code(500).send({ code: "PROFILE_FAILED", message: err instanceof Error ? err.message : "画像提炼失败" });
    }
  });
  app.post("/onboarding/derive-accounts", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body ?? {}) as { overwrite?: boolean };
    try {
      const { deriveAccountPositioning } = await import("../services/onboarding/company-profile.js");
      const result = await deriveAccountPositioning({
        tenantId: request.tenantId, userId: request.user.userId, overwrite: body.overwrite === true,
      });
      return { code: "OK", data: { accounts: result } };
    } catch (err) {
      return reply.code(500).send({ code: "DERIVE_FAILED", message: err instanceof Error ? err.message : "定位推导失败" });
    }
  });
  app.post("/onboarding/topic-pool", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body ?? {}) as { count?: number };
    try {
      const { generateTopicPool } = await import("../services/onboarding/company-profile.js");
      const topics = await generateTopicPool({
        tenantId: request.tenantId, userId: request.user.userId, count: body.count,
      });
      return { code: "OK", data: { topics, count: topics.length } };
    } catch (err) {
      return reply.code(500).send({ code: "TOPICS_FAILED", message: err instanceof Error ? err.message : "选题池生成失败" });
    }
  });

  /** PR-Z4: 租户套餐管理 — {plan, expiresAt, monthlyArticleQuota, monthlyVideoQuota, accountLimit} */
  app.get("/tenant-billing/:tenantId", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!UUID_RE.test(tenantId)) return reply.code(400).send({ code: "BAD_REQUEST", message: "tenantId 非法" });
    const { readBillingPlan } = await import("../services/billing/plan.js");
    return { code: "OK", data: { billing: await readBillingPlan(tenantId) } };
  });
  app.patch("/tenant-billing/:tenantId", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!UUID_RE.test(tenantId)) return reply.code(400).send({ code: "BAD_REQUEST", message: "tenantId 非法" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };
    const billing: Record<string, unknown> = {};
    if (typeof body.plan === "string" && body.plan) billing.plan = String(body.plan).slice(0, 30);
    if (typeof body.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt)) billing.expiresAt = body.expiresAt;
    if (num(body.monthlyArticleQuota)) billing.monthlyArticleQuota = num(body.monthlyArticleQuota);
    if (num(body.monthlyVideoQuota)) billing.monthlyVideoQuota = num(body.monthlyVideoQuota);
    if (num(body.accountLimit)) billing.accountLimit = num(body.accountLimit);
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) return reply.code(404).send({ code: "NOT_FOUND", message: "租户不存在" });
    const cfg = (t.config as Record<string, unknown>) || {};
    cfg.billing = billing; // 空对象 = 清除限制
    await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, tenantId));
    logger.info({ tenantId, billing }, "PR-Z4 租户套餐已更新");
    return { code: "OK", data: { billing } };
  });

  /** PR-W7: 每日生成/分发时间 — 仪表盘可配, 保存即热更新调度 */
  app.get("/schedule-times", { preHandler: adminOnlyMiddleware }, async () => {
    const { readScheduleTimes } = await import("../services/scheduler.js");
    return { code: "OK", data: await readScheduleTimes() };
  });
  app.patch("/schedule-times", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const body = (request.body ?? {}) as { generateTime?: string; distributeTime?: string };
    const re = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if ((body.generateTime && !re.test(body.generateTime)) || (body.distributeTime && !re.test(body.distributeTime))) {
      return reply.code(400).send({ code: "BAD_TIME", message: "时间格式须为 HH:MM" });
    }
    const { applyScheduleTimes } = await import("../services/scheduler.js");
    const applied = await applyScheduleTimes(body);
    // 持久化到 SYSTEM config (重启后生效)
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const cfg = (t?.config as Record<string, unknown>) || {};
    const auto = (cfg.automationConfig as Record<string, unknown>) || {};
    cfg.automationConfig = { ...auto, scheduleTimes: applied };
    await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID));
    logger.info(applied, "PR-W7 每日生成/分发时间已保存");
    return { code: "OK", data: applied };
  });

  // 5-19 PR #171: SSE stream admin only (跟随 POST /bulk-distribute 同权限)
  app.get("/bulk-distribute/:batchId/stream", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
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

  /**
   * POST /admin/roundup — 多刊盘点文章生成 (学同行风格).
   * body: { journalIds?: string[], discipline?, catalog?, count?, audience }
   * 生成 → 存 article 草稿 → 返回 contentId + title (去内容详情页查看/发布)。
   */
  app.post("/roundup", async (request, reply) => {
    try {
      const b = (request.body ?? {}) as { journalIds?: string[]; discipline?: string; catalog?: string; count?: number; audience?: string; scope?: string };
      const audience = (b.audience || "").trim() || "普通院校教师";
      const { title, html, journalCovers, journalIds } = await generateRoundupArticle({
        tenantId: request.tenantId, journalIds: b.journalIds, discipline: b.discipline,
        catalog: b.catalog, count: b.count, audience, scope: b.scope,
      });
      const [row] = await db.insert(contents).values({
        tenantId: request.tenantId,
        userId: request.user.userId,
        type: "article",
        title,
        body: html,
        ...initialStatusFields("draft"),
        metadata: { source: "roundup", templateId: "journal-roundup", audience, journalIds: b.journalIds ?? null, discipline: b.discipline ?? null, journalCovers },
      }).returning({ id: contents.id });
      // PR-N: 记录本次用到的刊 → "15天不重复"冷却
      if (row?.id && journalIds.length > 0) {
        await db.insert(journalUsage).values(
          journalIds.map((jid) => ({ tenantId: request.tenantId, journalId: jid, contentId: row.id }))
        );
      }
      return { code: "OK", data: { contentId: row?.id, title } };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "admin.roundup_failed");
      return reply.code(400).send({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "盘点生成失败" });
    }
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
