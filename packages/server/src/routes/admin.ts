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
  accountIds: z.array(z.string().uuid()).default([]),
  // PR-W5: exclusive=每账号按自己领域生成专属内容(count=每账号篇数, 互不重复); broadcast=老行为
  assignMode: z.enum(["exclusive", "broadcast"]).default("broadcast"),
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
  avatarTemplate: z.enum(["A_academic", "B_marketing", "C_popular", "E_industry"]).default("A_academic"),
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
      const batchAccountPairs: Array<{ batchId: string; accountId: string }> = []; // PR-W5 exclusive 配对
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
      const batchAccountPairs: Array<{ batchId: string; accountId: string }> = []; // PR-W5 exclusive 配对

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
      } else if (body.assignMode === "exclusive" && body.accountIds.length > 0) {
        // PR-W5 独家模式: 每账号按自己的领域定位生成专属内容, 同轮关键词/期刊都不重复
        const accts = await db
          .select({ id: platformAccounts.id, discipline: platformAccounts.discipline, disciplines: platformAccounts.disciplines, accountName: platformAccounts.accountName })
          .from(platformAccounts)
          .where(and(inArray(platformAccounts.id, body.accountIds), eq(platformAccounts.tenantId, request.tenantId)));
        if (accts.length === 0) {
          return reply.code(400).send({ code: "NO_ACCOUNTS", message: "所选账号不存在" });
        }
        const dayOfWeek = new Date().getDay();
        const rotation = DISCIPLINE_ROTATION[dayOfWeek] ?? [];
        const usedKeywordIds = new Set<string>();
        const usedJournalIds = new Set<string>();
        const perAccount = Math.min(body.count, 5); // 每账号篇数, 上限 5 防误操作爆量

        for (const acct of accts) {
          // 账号有定位用定位 (PR-W5b 多选数组优先, 兼容旧单选); 没定位按日轮换兜底
          const acctDiscs = Array.isArray(acct.disciplines) && (acct.disciplines as string[]).length > 0
            ? (acct.disciplines as string[])
            : acct.discipline ? [acct.discipline] : [];
          const discs = acctDiscs.length > 0 ? acctDiscs : (rotation.length > 0 ? rotation : null);
          // PR-W5c 防撞加固: 冷却阶梯放宽 30→14→7 天, 绝不放到 0 — 题库太薄时宁可少生成也不出近期旧题
          let cands = await selectCandidates({ disciplines: discs, cooldownDays: 30, poolSize: perAccount * 6 });
          for (const cd of [14, 7]) {
            if (cands.length >= perAccount + usedKeywordIds.size) break;
            const more = await selectCandidates({ disciplines: discs, cooldownDays: cd, poolSize: perAccount * 6 });
            const have = new Set(cands.map((c) => c.id));
            cands = cands.concat(more.filter((m) => !have.has(m.id)));
          }
          if (cands.length < perAccount) {
            logger.warn({ accountId: acct.id, discs, available: cands.length, want: perAccount }, "PR-W5c 该领域题库薄, 本轮少生成 (7天冷却内的题不复用)");
          }
          let made = 0;
          for (const kw of cands) {
            if (made >= perAccount) break;
            if (usedKeywordIds.has(kw.id)) continue; // 同轮不同账号不撞关键词
            try {
              const recs = await recommendJournals({ tenantId: request.tenantId, topic: kw.keyword, limit: 5 });
              let journalId: string | null = null;
              for (const r of recs) {
                if (usedJournalIds.has(r.id)) continue; // 同轮不撞期刊
                const use30d = await getJournal30dCount(r.id);
                if (use30d >= 5) continue;
                journalId = r.id;
                break;
              }
              if (!journalId) journalId = recs.find((r) => !usedJournalIds.has(r.id))?.id ?? recs[0]?.id ?? null;
              if (!journalId) continue;
              usedJournalIds.add(journalId);
              const result = await createBatch({
                tenantId: request.tenantId,
                userId: request.user.userId,
                filename: `excl-${acct.accountName.slice(0, 12)}-${kw.keyword.slice(0, 16)}-${Date.now()}`,
                rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template, priority: 1 }],
              });
              batchIds.push(result.batchId);
              batchAccountPairs.push({ batchId: result.batchId, accountId: acct.id });
              selectedKeywordIds.push(kw.id);
              usedKeywordIds.add(kw.id);
              made++;
            } catch (err) {
              logger.warn({ accountId: acct.id, keyword: kw.keyword, err }, "PR-W5 exclusive 单篇入队失败 (跳过)");
            }
          }
          if (made === 0) {
            logger.warn({ accountId: acct.id, discipline: acct.discipline }, "PR-W5 exclusive 该账号无可用关键词, 0 篇");
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
              rows: [{ rowIndex: 1, topic: kw.keyword, journalId, template, priority: 1 }],
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
          assignMode: body.assignMode,
          batchAccountPairs, // PR-W5: exclusive 模式下 batch↔账号 配对, 前端按此精准发布
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
    const validTypes = new Set(["domestic", "international", "roundup"]);
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
    logger.info({ contentQuota: clean, total }, "PR-O 每日内容配置(按类型)已更新");
    return { code: "OK", data: { contentQuota: clean, total } };
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
