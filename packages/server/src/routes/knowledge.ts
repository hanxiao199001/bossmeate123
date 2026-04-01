import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../config/logger.js";
import { VECTOR_CATEGORIES, type VectorCategory } from "../services/knowledge/vector-store.js";
import {
  createEntry,
  getEntry,
  updateEntry,
  deleteEntry,
  listEntries,
  semanticSearch,
  hybridSearch,
  getStats,
  PG_ONLY_CATEGORIES,
} from "../services/knowledge/knowledge-service.js";
import { runAuditPipeline, runBatchAudit } from "../services/knowledge/audit-pipeline.js";
import { runColdStart, type ColdStartConfig } from "../services/knowledge/cold-start.js";

const allCategories = [...VECTOR_CATEGORIES, ...PG_ONLY_CATEGORIES] as readonly string[];

// ============ 入参校验 ============

const createSchema = z.object({
  category: z.string().refine((v) => allCategories.includes(v), {
    message: "无效的 category",
  }),
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.string().min(1).optional(),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1),
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(10),
  minScore: z.coerce.number().min(0).max(1).optional(),
});

const hybridSearchSchema = z.object({
  query: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(10),
});

const auditSchema = z.object({
  category: z.string().refine(
    (v) => (VECTOR_CATEGORIES as readonly string[]).includes(v),
    { message: "审核仅支持向量分区 category" }
  ),
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const coldStartSchema = z.object({
  industry: z.string().min(1),
  subIndustry: z.string().optional(),
  seedCompetitors: z.array(z.string()).optional(),
  platforms: z.array(z.string()).optional(),
  ipQuestionnaire: z
    .object({
      brandName: z.string().min(1),
      targetAudience: z.string().min(1),
      toneOfVoice: z.string().min(1),
      contentGoals: z.array(z.string()),
      tabooTopics: z.array(z.string()).optional(),
      referenceAccounts: z.array(z.string()).optional(),
    })
    .optional(),
});

// ============ 路由注册 ============

export async function knowledgeRoutes(app: FastifyInstance) {
  // ====== CRUD ======

  /** POST /knowledge — 创建知识条目 */
  app.post("/", async (request, reply) => {
    const body = createSchema.parse(request.body);
    const entry = await createEntry({
      tenantId: request.tenantId,
      category: body.category as any,
      title: body.title,
      content: body.content,
      source: body.source,
      metadata: body.metadata,
    });
    return reply.status(201).send({ success: true, data: entry });
  });

  /** GET /knowledge/:id — 查询单条 */
  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await getEntry(id, request.tenantId);
    if (!entry) {
      return reply.status(404).send({ success: false, error: "条目不存在" });
    }
    return { success: true, data: entry };
  });

  /** GET /knowledge — 列表查询 */
  app.get("/", async (request) => {
    const query = request.query as {
      category?: string;
      keyword?: string;
      limit?: string;
      offset?: string;
    };
    const entries = await listEntries({
      tenantId: request.tenantId,
      category: query.category as any,
      keyword: query.keyword,
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    });
    return { success: true, data: entries, count: entries.length };
  });

  /** PUT /knowledge/:id — 更新 */
  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);
    const updated = await updateEntry(id, request.tenantId, body);
    if (!updated) {
      return reply.status(404).send({ success: false, error: "条目不存在" });
    }
    return { success: true, data: updated };
  });

  /** DELETE /knowledge/:id — 删除 */
  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteEntry(id, request.tenantId);
    if (!deleted) {
      return reply.status(404).send({ success: false, error: "条目不存在" });
    }
    return { success: true };
  });

  // ====== 向量检索 ======

  /** POST /knowledge/search — 语义搜索 */
  app.post("/search", async (request) => {
    const body = searchSchema.parse(request.body);
    const results = await semanticSearch({
      tenantId: request.tenantId,
      query: body.query,
      category: body.category as VectorCategory | undefined,
      limit: body.limit,
      minScore: body.minScore,
    });
    return { success: true, data: results, count: results.length };
  });

  /** POST /knowledge/hybrid-search — 混合搜索 */
  app.post("/hybrid-search", async (request) => {
    const body = hybridSearchSchema.parse(request.body);
    const results = await hybridSearch({
      tenantId: request.tenantId,
      query: body.query,
      keywords: body.keywords,
      category: body.category as VectorCategory | undefined,
      limit: body.limit,
    });
    return { success: true, data: results, count: results.length };
  });

  // ====== 审核管线 ======

  /** POST /knowledge/audit — 单条审核入库 */
  app.post("/audit", async (request) => {
    const body = auditSchema.parse(request.body);
    const result = await runAuditPipeline({
      tenantId: request.tenantId,
      category: body.category as VectorCategory,
      title: body.title,
      content: body.content,
      source: body.source,
      metadata: body.metadata,
    });
    return { success: true, data: result };
  });

  /** POST /knowledge/audit/batch — 批量审核入库 */
  app.post("/audit/batch", async (request) => {
    const items = z.array(auditSchema).parse(request.body);
    const inputs = items.map((item) => ({
      tenantId: request.tenantId,
      category: item.category as VectorCategory,
      title: item.title,
      content: item.content,
      source: item.source,
      metadata: item.metadata,
    }));
    const result = await runBatchAudit(inputs);
    return {
      success: true,
      data: {
        acceptedCount: result.accepted.length,
        rejectedCount: result.rejected.length,
        accepted: result.accepted,
        rejected: result.rejected,
      },
    };
  });

  // ====== 冷启动 ======

  /** POST /knowledge/cold-start — 触发冷启动流程 */
  app.post("/cold-start", async (request) => {
    const body = coldStartSchema.parse(request.body);
    const config: ColdStartConfig = {
      tenantId: request.tenantId,
      ...body,
    };
    const progress = await runColdStart(config);
    return { success: true, data: progress };
  });

  // ====== 统计 ======

  /** GET /knowledge/stats — 各子库统计 */
  app.get("/stats", async (request) => {
    const stats = await getStats(request.tenantId);
    return { success: true, data: stats };
  });
}
