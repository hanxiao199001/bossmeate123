/**
 * Golden Set 标注接口(8-02)。
 *
 * 【这是什么】老板对内容质量的判断, 一条一条落库, 成为整个系统的**质量基准线**。
 *   系统现在没有任何评估体系: 改了 prompt 不知道变好变坏、六维评分器的信度从没验过
 *   (两个模型对同一批文章评分相关性只有 r=0.254)、老板走后没人能校准标尺。
 *   标完这批数据立刻能做三件事: ①算"人的判断 vs 六维分"的相关性(验证评分器可不可信)
 *   ②当回归基准(以后每次 prompt/模型改动跑一遍对比) ③从自由文本理由里提炼
 *   "驳回原因分类词表"(那是反馈闭环的输入定义)。
 *
 * 【🔴 防锚定是本文件的第一原则】
 *   candidates / content/:id 两个接口**在服务端**就把评分、AI 审稿、质检状态全部剔掉,
 *   而不是"前端不显示"。理由与实现见 services/golden-set/anchor-guard.ts 文件头。
 *   system-scores 接口另加一道时序闸: 你没标过这一篇, 服务端就不给你看分。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, or, sql, desc, inArray, gte } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents, journals, goldenSetAnnotations, users } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { requirePermission } from "../middleware/permission.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { GOLDEN_LABELS, GOLDEN_LABEL_ORDINAL, type GoldenLabel } from "../services/golden-set/labels.js";
import {
  assertBlind,
  buildBlindCard,
  AnchorLeakError,
  type BlindCard,
  type BlindCardSource,
} from "../services/golden-set/anchor-guard.js";
import { planSample, scoreBand, type PoolItem } from "../services/golden-set/sampling.js";

/** 与内容工坊同一套读权口径: 自己租户 + 系统推荐租户(日更内容都落在那儿) */
const READABLE_TENANT = (tenantId: string) =>
  or(eq(contents.tenantId, tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID))!;

/** 标注目标(前端进度条的分母)。50 篇是"够算相关性 + 老板 4-5 小时标得完"的交点。 */
export const GOLDEN_SET_TARGET = 50;

const annotateSchema = z.object({
  contentId: z.string().uuid(),
  label: z.enum(GOLDEN_LABELS as unknown as [GoldenLabel, ...GoldenLabel[]]),
  reason: z.string().max(2000).optional(),
});

/** 只有真正成文的内容才值得标(generating/failed 是流水线中间态, 标了没有意义)。 */
const ANNOTATABLE_STATUSES = ["generated", "needs_review", "published", "archived", "draft"] as const;

export async function goldenSetRoutes(app: FastifyInstance) {
  /**
   * GET /golden-set/candidates
   *   strategy=sampled(默认, 分层智能采样) | recent(最近) | mine(我标过的)
   *   limit / days / kind / status
   *
   * 🔴 响应里没有任何评分字段 —— 池子查询(带分数)与卡片查询(不带分数)是两条独立的 SQL,
   *    分数只在服务端内存里用于分层, 从不进入返回值。最后再过一道 assertBlind。
   */
  app.get("/candidates", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    try {
      const q = request.query as {
        strategy?: string; limit?: string; days?: string;
        kind?: string; status?: string; includeAnnotated?: string;
      };
      const strategy = q.strategy === "recent" || q.strategy === "mine" ? q.strategy : "sampled";
      const limit = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10) || 50));
      const days = Math.min(3650, Math.max(1, parseInt(q.days || "180", 10) || 180));
      const annotatorId = request.user.userId;

      // ---------- mine: 我标过的(可回看/可改, 这条路径允许带上我自己的标) ----------
      if (strategy === "mine") {
        const mineRows = await db
          .select({ contentId: goldenSetAnnotations.contentId })
          .from(goldenSetAnnotations)
          .where(eq(goldenSetAnnotations.annotatorId, annotatorId))
          .orderBy(desc(goldenSetAnnotations.updatedAt))
          .limit(limit);
        const ids = mineRows.map((r) => r.contentId);
        const cards = await loadBlindCards(ids, request.tenantId, annotatorId);
        return assertBlind({ code: "OK", data: { strategy, total: cards.length, items: cards } });
      }

      // ---------- 候选池: 带分数(仅服务端用), 绝不下发 ----------
      const since = new Date(Date.now() - days * 24 * 3600 * 1000);
      const statusFilter = q.status && (ANNOTATABLE_STATUSES as readonly string[]).includes(q.status)
        ? [q.status]
        : [...ANNOTATABLE_STATUSES];

      const poolRows = await db
        .select({
          id: contents.id,
          status: contents.status,
          type: contents.type,
          createdAt: contents.createdAt,
          // 采样用: 六维总分 / 是否降级(没评上分)。⚠️ 这两列只留在服务端内存。
          sixDimTotal: sql<string | null>`${contents.metadata}->>'sixDimTotal'`,
          sixDimDegraded: sql<string | null>`${contents.metadata}->>'sixDimDegraded'`,
          journalId: sql<string | null>`${contents.metadata}->>'journalId'`,
          isRoundup: sql<boolean>`(${contents.metadata}->>'source' = 'roundup' OR ${contents.metadata}->>'templateId' = 'journal-roundup')`,
          journalKind: journals.journalKind,
          // 已被我标过的不再进"待标"池(但 includeAnnotated=true 时保留)
          myLabel: sql<string | null>`(
            SELECT a.label FROM golden_set_annotations a
             WHERE a.content_id = ${contents.id} AND a.annotator_id = ${annotatorId}::uuid LIMIT 1
          )`,
        })
        .from(contents)
        // 用 text 比较而不是 ::uuid 强转: 历史 metadata.journalId 里混过非 uuid 串, 一旦强转整条查询直接报错
        .leftJoin(journals, sql`${journals.id}::text = ${contents.metadata}->>'journalId'`)
        .where(
          and(
            READABLE_TENANT(request.tenantId),
            inArray(contents.status, statusFilter),
            gte(contents.createdAt, since),
            sql`COALESCE(length(${contents.body}), 0) > 200`, // 空/残稿没有标注价值
          )
        )
        .orderBy(desc(contents.createdAt))
        .limit(2000); // 池子上限: 够分层了, 也不至于把一次请求拖垮

      const includeAnnotated = q.includeAnnotated === "true";
      let pool = poolRows.filter((r) => includeAnnotated || !r.myLabel);
      if (q.kind) {
        pool = pool.filter((r) => cardKindOf(r) === q.kind);
      }

      let ids: string[];
      let sampleMeta: Record<string, unknown> = {};
      if (strategy === "recent") {
        ids = pool.slice(0, limit).map((r) => r.id);
      } else {
        const items: PoolItem[] = pool.map((r) => ({
          id: r.id,
          score: r.sixDimTotal === null ? null : Number(r.sixDimTotal),
          degraded: r.sixDimDegraded === "true",
          kind: cardKindOf(r),
          status: r.status,
          createdAt: r.createdAt,
        }));
        const plan = planSample(items, limit);
        ids = plan.ids;
        // 分布只进日志, 不进响应 —— bandCounts 里带着 high/mid/low 就是分数信息。
        sampleMeta = { bandCounts: plan.bandCounts, kindCounts: plan.kindCounts, weekCounts: Object.keys(plan.weekCounts).length };
        logger.info({ poolSize: pool.length, picked: ids.length, ...sampleMeta }, "Golden Set 分层采样完成");
      }

      const cards = await loadBlindCards(ids, request.tenantId, annotatorId);
      return assertBlind({
        code: "OK",
        data: {
          strategy,
          poolSize: pool.length,
          total: cards.length,
          items: cards,
        },
      });
    } catch (err) {
      if (err instanceof AnchorLeakError) {
        logger.error({ leaks: err.leaks }, "🔴 防锚定闸拦截: candidates 响应含评分字段, 已阻断");
        return reply.code(500).send({ code: "ANCHOR_LEAK", message: "防锚定校验未通过，请联系开发" });
      }
      logger.error({ err }, "Golden Set 候选拉取失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /golden-set/content/:id — 单篇详情。同样零评分字段。
   */
  app.get("/content/:id", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const [card] = await loadBlindCards([id], request.tenantId, request.user.userId);
      if (!card) return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      return assertBlind({ code: "OK", data: card });
    } catch (err) {
      if (err instanceof AnchorLeakError) {
        logger.error({ leaks: err.leaks }, "🔴 防锚定闸拦截: content 详情含评分字段, 已阻断");
        return reply.code(500).send({ code: "ANCHOR_LEAK", message: "防锚定校验未通过，请联系开发" });
      }
      logger.error({ err }, "Golden Set 详情拉取失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /golden-set/annotate — 落标注(自动保存, 前端不需要提交按钮)。
   * 幂等: UNIQUE(content_id, annotator_id) + ON CONFLICT UPDATE → 同一人对同一篇永远只有一条, 可改。
   */
  app.post("/annotate", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    try {
      const parsed = annotateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "INVALID_PARAMS", message: "参数不合法", data: parsed.error.flatten() });
      }
      const { contentId, label, reason } = parsed.data;

      // 越权防御: 只能标自己看得见的内容
      const [target] = await db
        .select({ id: contents.id })
        .from(contents)
        .where(and(eq(contents.id, contentId), READABLE_TENANT(request.tenantId)))
        .limit(1);
      if (!target) return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });

      const now = new Date();
      const [row] = await db
        .insert(goldenSetAnnotations)
        .values({
          contentId,
          tenantId: request.tenantId,
          annotatorId: request.user.userId,
          label,
          reason: reason?.trim() ? reason.trim() : null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [goldenSetAnnotations.contentId, goldenSetAnnotations.annotatorId],
          set: { label, reason: reason?.trim() ? reason.trim() : null, updatedAt: now },
        })
        .returning({ id: goldenSetAnnotations.id, label: goldenSetAnnotations.label });

      logger.info({ contentId, annotatorId: request.user.userId, label }, "Golden Set 标注已保存");
      // 这里返回 label 不违反防锚定 —— 是标注人自己刚提交的判断, 不是系统评价。
      return { code: "OK", data: { id: row?.id ?? null, label: row?.label ?? label } };
    } catch (err) {
      logger.error({ err }, "Golden Set 标注保存失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /golden-set/content/:id/system-scores — 标完之后才能看的系统评分。
   *
   * 🔴 时序闸: 调用者必须**已经标过这一篇**, 否则 409。
   *   为什么做成硬闸而不是靠前端自觉: 前端"标完才请求"是一行代码的事, 也是一行代码就能被改掉的事;
   *   而一旦某次改动让它提前请求, 数据废掉的过程完全静默。闸放服务端, 谁都绕不过。
   */
  app.get("/content/:id/system-scores", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const [mine] = await db
        .select({ id: goldenSetAnnotations.id })
        .from(goldenSetAnnotations)
        .where(and(eq(goldenSetAnnotations.contentId, id), eq(goldenSetAnnotations.annotatorId, request.user.userId)))
        .limit(1);
      if (!mine) {
        return reply.code(409).send({
          code: "NOT_ANNOTATED_YET",
          message: "请先给出你的判断，再看系统评分（防锚定）",
        });
      }

      const [row] = await db
        .select({ id: contents.id, status: contents.status, metadata: contents.metadata })
        .from(contents)
        .where(and(eq(contents.id, id), READABLE_TENANT(request.tenantId)))
        .limit(1);
      if (!row) return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });

      const md = (row.metadata as Record<string, unknown> | null) ?? {};
      const degraded = md.sixDimDegraded === true;
      return {
        code: "OK",
        data: {
          // ⚠️ 7-27 教训: 没评上分是 null, **不是 0 分**。前端照此显示"未评分"。
          sixDimTotal: degraded || typeof md.sixDimTotal !== "number" ? null : md.sixDimTotal,
          sixDimScores: (md.sixDimScores as unknown) ?? null,
          sixDimPassed: typeof md.sixDimPassed === "boolean" ? md.sixDimPassed : null,
          sixDimDegraded: degraded,
          sixDimWeak: Array.isArray(md.sixDimWeak) ? md.sixDimWeak : [],
          qualityScore: typeof md.qualityScore === "number" ? md.qualityScore : null,
          aiReview: (md.aiReview as unknown) ?? null,
          status: row.status,
          needsReviewReason: (md.needsReviewReason as string | undefined) ?? null,
        },
      };
    } catch (err) {
      logger.error({ err }, "Golden Set 系统评分拉取失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /golden-set/stats — 进度条数据: 我标了多少 / 全站标了多少 / 分布。
   */
  app.get("/stats", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    try {
      const annotatorId = request.user.userId;
      const rows = await db
        .select({
          label: goldenSetAnnotations.label,
          annotatorId: goldenSetAnnotations.annotatorId,
          cnt: sql<number>`count(*)::int`,
          withReason: sql<number>`count(*) FILTER (WHERE ${goldenSetAnnotations.reason} IS NOT NULL AND btrim(${goldenSetAnnotations.reason}) <> '')::int`,
        })
        .from(goldenSetAnnotations)
        .where(eq(goldenSetAnnotations.tenantId, request.tenantId))
        .groupBy(goldenSetAnnotations.label, goldenSetAnnotations.annotatorId);

      const dist: Record<string, number> = { good: 0, fair: 0, poor: 0 };
      const myDist: Record<string, number> = { good: 0, fair: 0, poor: 0 };
      let total = 0, mine = 0, myWithReason = 0;
      const annotators = new Set<string>();
      for (const r of rows) {
        total += r.cnt;
        dist[r.label] = (dist[r.label] ?? 0) + r.cnt;
        annotators.add(r.annotatorId);
        if (r.annotatorId === annotatorId) {
          mine += r.cnt;
          myWithReason += r.withReason;
          myDist[r.label] = (myDist[r.label] ?? 0) + r.cnt;
        }
      }
      return {
        code: "OK",
        data: {
          target: GOLDEN_SET_TARGET,
          total,
          mine,
          myWithReason,
          annotatorCount: annotators.size,
          distribution: dist,
          myDistribution: myDist,
        },
      };
    } catch (err) {
      logger.error({ err }, "Golden Set 统计失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /golden-set/export — 标注 × 系统分的对照表(算相关性/建回归基准用)。
   *
   * 这个接口**可以**带分数 —— 它是标注完成之后的分析路径, 不是采集路径。
   * (它没有 assertBlind, 是刻意的; 别把它接进标注页面。)
   */
  app.get("/export", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    try {
      const rows = await db
        .select({
          contentId: goldenSetAnnotations.contentId,
          label: goldenSetAnnotations.label,
          reason: goldenSetAnnotations.reason,
          annotatorId: goldenSetAnnotations.annotatorId,
          annotatorName: users.name,
          annotatedAt: goldenSetAnnotations.updatedAt,
          title: contents.title,
          contentStatus: contents.status,
          contentType: contents.type,
          contentCreatedAt: contents.createdAt,
          sixDimTotal: sql<string | null>`${contents.metadata}->>'sixDimTotal'`,
          sixDimDegraded: sql<string | null>`${contents.metadata}->>'sixDimDegraded'`,
          qualityScore: sql<string | null>`${contents.metadata}->>'qualityScore'`,
        })
        .from(goldenSetAnnotations)
        .innerJoin(contents, eq(contents.id, goldenSetAnnotations.contentId))
        .leftJoin(users, eq(users.id, goldenSetAnnotations.annotatorId))
        .where(eq(goldenSetAnnotations.tenantId, request.tenantId))
        .orderBy(desc(goldenSetAnnotations.updatedAt));

      const items = rows.map((r) => {
        const degraded = r.sixDimDegraded === "true";
        const score = degraded || r.sixDimTotal === null ? null : Number(r.sixDimTotal);
        return {
          contentId: r.contentId,
          title: r.title,
          label: r.label,
          labelOrdinal: GOLDEN_LABEL_ORDINAL[r.label as GoldenLabel] ?? null,
          reason: r.reason,
          annotator: r.annotatorName ?? r.annotatorId,
          annotatedAt: r.annotatedAt,
          contentStatus: r.contentStatus,
          contentType: r.contentType,
          contentCreatedAt: r.contentCreatedAt,
          sixDimTotal: score,
          // 分数段仍按同一口径切, 分析脚本不用再抄一份阈值
          scoreBand: scoreBand(score, degraded),
          qualityScore: r.qualityScore === null ? null : Number(r.qualityScore),
        };
      });
      return { code: "OK", data: { total: items.length, items } };
    } catch (err) {
      logger.error({ err }, "Golden Set 导出失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });
}

// ============ 内部 helper ============

/** 池行 → 形态标签(与 anchor-guard.resolveContentKind 同一口径, 这里只是提前算给分层用) */
function cardKindOf(r: { type: string | null; isRoundup: boolean; journalKind: string | null }): string {
  if (r.type === "video" || r.type === "video_script") return "video";
  if (r.isRoundup) return "roundup";
  if (r.journalKind === "intl") return "international";
  if (r.journalKind === "cn" || r.journalKind === "both") return "domestic";
  return "other";
}

/**
 * 按 id 拉标注卡。
 *
 * 🔴 这里的 select 映射就是防锚定的第一层锁 —— **一个评分字段都没有**:
 *   没有 contents.metadata(六维分全在里面)、没有 contents.status(待审=强锚)。
 *   要加字段前先想清楚它会不会泄露系统对这篇的评价。
 */
async function loadBlindCards(ids: string[], tenantId: string, annotatorId: string): Promise<BlindCard[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: contents.id,
      title: contents.title,
      body: contents.body,
      type: contents.type,
      createdAt: contents.createdAt,
      isRoundup: sql<boolean>`(${contents.metadata}->>'source' = 'roundup' OR ${contents.metadata}->>'templateId' = 'journal-roundup')`,
      journalId: journals.id,
      journalName: journals.name,
      journalNameEn: journals.nameEn,
      journalKind: journals.journalKind,
      impactFactor: journals.impactFactor,
      compositeImpactFactor: journals.compositeImpactFactor,
      partition: journals.partition,
      casPartitionNew: journals.casPartitionNew,
      catalogs: journals.catalogs,
      cscdLevel: journals.cscdLevel,
      pkuCoreLevel: journals.pkuCoreLevel,
      myLabel: sql<string | null>`(
        SELECT a.label FROM golden_set_annotations a
         WHERE a.content_id = ${contents.id} AND a.annotator_id = ${annotatorId}::uuid LIMIT 1
      )`,
      myReason: sql<string | null>`(
        SELECT a.reason FROM golden_set_annotations a
         WHERE a.content_id = ${contents.id} AND a.annotator_id = ${annotatorId}::uuid LIMIT 1
      )`,
    })
    .from(contents)
    // 用 text 比较而不是 ::uuid 强转: 历史 metadata.journalId 里混过非 uuid 串, 一旦强转整条查询直接报错
        .leftJoin(journals, sql`${journals.id}::text = ${contents.metadata}->>'journalId'`)
    .where(and(inArray(contents.id, ids), READABLE_TENANT(tenantId)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  // 保持 planSample 给出的顺序(它已按分数段交替打散)
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => {
      const src: BlindCardSource = {
        id: r.id,
        title: r.title,
        body: r.body,
        type: r.type,
        createdAt: r.createdAt,
        isRoundup: r.isRoundup === true,
        journal: r.journalId
          ? {
              id: r.journalId,
              name: r.journalName,
              nameEn: r.journalNameEn,
              journalKind: r.journalKind,
              impactFactor: r.impactFactor,
              compositeImpactFactor: r.compositeImpactFactor,
              partition: r.partition,
              casPartitionNew: r.casPartitionNew,
              catalogs: Array.isArray(r.catalogs) ? (r.catalogs as unknown[]).map(String) : [],
              cscdLevel: r.cscdLevel,
              pkuCoreLevel: r.pkuCoreLevel,
            }
          : null,
        myLabel: r.myLabel,
        myReason: r.myReason,
      };
      return buildBlindCard(src);
    });
}

/** 供测试断言用: 标注卡永远只有这些 key。 */
export const BLIND_CARD_KEYS = [
  "id", "title", "body", "kind", "kindText", "createdAt", "journal", "myLabel", "myReason",
] as const;

