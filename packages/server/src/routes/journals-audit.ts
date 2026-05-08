/**
 * PR 2（5-9 早）：/admin/journals/audit 后端只读 API。
 *
 * GET /api/v1/admin/journals/audit/stats — 6 卡片数据（总数 + 4 confidence 区间 + AI编造 + 从未验证）
 * GET /api/v1/admin/journals/audit       — 列表 + filter + 分页（confidence ASC NULLS FIRST）
 *
 * 仅 owner / admin 角色可访问；filter + sort 走数据库（不做应用层过滤）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, count, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { logger } from "../config/logger.js";

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
  // data_source 多选（逗号分隔）
  dataSources: z.string().optional(),
  // confidence range（任一可缺）
  confidenceMin: z.coerce.number().int().min(0).max(100).optional(),
  confidenceMax: z.coerce.number().int().min(0).max(100).optional(),
  // 验证时间筛选：'never' = IS NULL；'older_than_30d' / 'within_30d'
  verified: z.enum(["never", "older_than_30d", "within_30d"]).optional(),
  // 期刊名 / nameEn ilike 搜索
  q: z.string().optional(),
});

function isAdmin(role: unknown): boolean {
  return role === "owner" || role === "admin";
}

export async function journalsAuditRoutes(app: FastifyInstance) {
  /** PR 2: 6 卡片数据（按 spec 第二段顶部统计）*/
  app.get("/admin/journals/audit/stats", async (request, reply) => {
    if (!isAdmin(request.user.role)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "需要 admin 角色" });
    }
    const tenantFilter = eq(journals.tenantId, request.tenantId);

    const [
      totalRow,
      highRow,
      midRow,
      lowRow,
      aiRow,
      neverRow,
    ] = await Promise.all([
      db.select({ c: count() }).from(journals).where(tenantFilter),
      db.select({ c: count() }).from(journals).where(and(tenantFilter, gte(journals.confidence, 80))),
      db
        .select({ c: count() })
        .from(journals)
        .where(and(tenantFilter, gte(journals.confidence, 50), lte(journals.confidence, 79))),
      db
        .select({ c: count() })
        .from(journals)
        .where(and(tenantFilter, lte(journals.confidence, 49))),
      db
        .select({ c: count() })
        .from(journals)
        .where(and(tenantFilter, eq(journals.dataSource, "ai_fabricated"))),
      db.select({ c: count() }).from(journals).where(and(tenantFilter, isNull(journals.lastVerifiedAt))),
    ]);

    return {
      code: "OK",
      data: {
        total: Number(totalRow[0]?.c ?? 0),
        highConfidence: Number(highRow[0]?.c ?? 0),
        midConfidence: Number(midRow[0]?.c ?? 0),
        lowConfidence: Number(lowRow[0]?.c ?? 0),
        aiFabricated: Number(aiRow[0]?.c ?? 0),
        neverVerified: Number(neverRow[0]?.c ?? 0),
      },
    };
  });

  /** PR 2: 列表 + filter + 分页 */
  app.get("/admin/journals/audit", async (request, reply) => {
    if (!isAdmin(request.user.role)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "需要 admin 角色" });
    }

    let parsed: z.infer<typeof auditQuerySchema>;
    try {
      parsed = auditQuerySchema.parse(request.query);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }

    const conditions = [eq(journals.tenantId, request.tenantId)];

    if (parsed.dataSources) {
      const list = parsed.dataSources.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) conditions.push(inArray(journals.dataSource, list));
    }
    if (typeof parsed.confidenceMin === "number") {
      conditions.push(gte(journals.confidence, parsed.confidenceMin));
    }
    if (typeof parsed.confidenceMax === "number") {
      conditions.push(lte(journals.confidence, parsed.confidenceMax));
    }
    if (parsed.verified === "never") {
      conditions.push(isNull(journals.lastVerifiedAt));
    } else if (parsed.verified === "older_than_30d") {
      conditions.push(sql`${journals.lastVerifiedAt} < NOW() - INTERVAL '30 days'`);
    } else if (parsed.verified === "within_30d") {
      conditions.push(sql`${journals.lastVerifiedAt} >= NOW() - INTERVAL '30 days'`);
    }
    if (parsed.q) {
      const kw = `%${parsed.q}%`;
      conditions.push(or(ilike(journals.name, kw), ilike(journals.nameEn, kw))!);
    }

    const whereClause = and(...conditions);
    const offset = (parsed.page - 1) * parsed.pageSize;

    try {
      const [list, totalRow] = await Promise.all([
        db
          .select({
            id: journals.id,
            name: journals.name,
            nameEn: journals.nameEn,
            issn: journals.issn,
            dataSource: journals.dataSource,
            sourceUrl: journals.sourceUrl,
            confidence: journals.confidence,
            lastVerifiedAt: journals.lastVerifiedAt,
            updatedAt: journals.updatedAt,
          })
          .from(journals)
          .where(whereClause)
          // spec：confidence ASC NULLS FIRST → 走 idx_journals_confidence
          .orderBy(sql`${journals.confidence} ASC NULLS FIRST`, asc(journals.name))
          .limit(parsed.pageSize)
          .offset(offset),
        db.select({ c: count() }).from(journals).where(whereClause),
      ]);

      return {
        code: "OK",
        data: {
          items: list,
          total: Number(totalRow[0]?.c ?? 0),
          page: parsed.page,
          pageSize: parsed.pageSize,
        },
      };
    } catch (err) {
      logger.error({ err }, "PR 2: 期刊审计列表查询失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败" });
    }
  });

  /**
   * PR #107（5-9 治理 PR 3）：手动重新验证单个期刊。
   *
   * POST /api/v1/admin/journals/:id/reverify
   *   - admin only
   *   - 同步触发 enrichJournal（4 源全跑 + trust 计算 + DB 写回）
   *   - 返回 { confidence, dataSource, lastVerifiedAt, sourceUrl, successFields, failedFields, durationMs }
   *
   * 接入点：PR #105 audit 页 "🔄 重新验证" 按钮（PR 2 已 disabled 占位，本 PR enable）
   */
  app.post("/admin/journals/:id/reverify", async (request, reply) => {
    if (!isAdmin(request.user.role)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "需要 admin 角色" });
    }
    const { id } = request.params as { id: string };
    if (!id || typeof id !== "string") {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "missing id" });
    }

    // 校验期刊归属当前 tenant
    const [row] = await db
      .select({ id: journals.id })
      .from(journals)
      .where(and(eq(journals.id, id), eq(journals.tenantId, request.tenantId)))
      .limit(1);
    if (!row) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "期刊不存在或无访问权限" });
    }

    try {
      const { enrichJournal } = await import("../services/journal-enricher/orchestrator.js");
      const result = await enrichJournal(id, {});

      // 重新读取最新 trust 字段返回前端（enrichJournal 写完后）
      const [updated] = await db
        .select({
          confidence: journals.confidence,
          dataSource: journals.dataSource,
          sourceUrl: journals.sourceUrl,
          lastVerifiedAt: journals.lastVerifiedAt,
        })
        .from(journals)
        .where(eq(journals.id, id))
        .limit(1);

      return {
        code: "OK",
        data: {
          ...updated,
          successFields: result.successFields,
          failedFields: result.failedFields,
          durationMs: result.durationMs,
        },
      };
    } catch (err) {
      logger.error({ err, id }, "PR #107: reverify 失败");
      return reply.code(500).send({
        code: "ENRICH_ERROR",
        message: err instanceof Error ? err.message : "enrich 异常",
      });
    }
  });
}
