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
  type KnowledgeCategory,
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

// seedCompetitors 支持字符串数组或对象数组
const seedCompetitorItem = z.union([
  z.string(),
  z.object({
    name: z.string(),
    platform: z.string().optional(),
    accountId: z.string().optional(),
  }),
]);

const coldStartSchema = z.object({
  industry: z.string().min(1),
  subIndustry: z.string().optional(),
  seedCompetitors: z.array(seedCompetitorItem).optional(),
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

// 英文行业名 → 中文映射（模板用中文key）
const INDUSTRY_NAME_MAP: Record<string, string> = {
  education: "教育",
  medical: "医学",
  medicine: "医学",
  tech: "科技",
  finance: "金融",
};

// ============ 路由注册 ============

export async function knowledgeRoutes(app: FastifyInstance) {
  // ====== CRUD ======

  /** POST /knowledge — 创建知识条目 */
  app.post("/", async (request, reply) => {
    try {
      const body = createSchema.parse(request.body);
      const entry = await createEntry({
        tenantId: request.tenantId,
        category: body.category as KnowledgeCategory,
        title: body.title,
        content: body.content,
        source: body.source,
        metadata: body.metadata,
      });
      return reply.status(201).send({ success: true, data: entry });
    } catch (err) {
      logger.error({ err }, "创建知识条目失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  /** GET /knowledge/:id — 查询单条 */
  app.get("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const entry = await getEntry(id, request.tenantId);
      if (!entry) {
        return reply.status(404).send({ success: false, error: "条目不存在" });
      }
      return { success: true, data: entry };
    } catch (err) {
      logger.error({ err }, "获取知识条目失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  /** GET /knowledge — 列表查询 */
  app.get("/", async (request, reply) => {
    try {
      const query = request.query as {
        category?: string;
        keyword?: string;
        limit?: string;
        offset?: string;
      };
      const entries = await listEntries({
        tenantId: request.tenantId,
        category: query.category as KnowledgeCategory | undefined,
        keyword: query.keyword,
        limit: query.limit ? parseInt(query.limit, 10) : 50,
        offset: query.offset ? parseInt(query.offset, 10) : 0,
      });
      return { success: true, data: entries, entries, count: entries.length };
    } catch (err) {
      logger.error({ err }, "列表查询知识条目失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  /** PUT /knowledge/:id — 更新 */
  app.put("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateSchema.parse(request.body);
      const updated = await updateEntry(id, request.tenantId, body);
      if (!updated) {
        return reply.status(404).send({ success: false, error: "条目不存在" });
      }
      return { success: true, data: updated };
    } catch (err) {
      logger.error({ err }, "更新知识条目失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  /** DELETE /knowledge/:id — 删除 */
  app.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const deleted = await deleteEntry(id, request.tenantId);
      if (!deleted) {
        return reply.status(404).send({ success: false, error: "条目不存在" });
      }
      return { success: true };
    } catch (err) {
      logger.error({ err }, "删除知识条目失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  // ====== 向量检索 ======

  /** POST /knowledge/search — 语义搜索 */
  app.post("/search", async (request, reply) => {
    try {
      const body = searchSchema.parse(request.body);
      const results = await semanticSearch({
        tenantId: request.tenantId,
        query: body.query,
        category: body.category as VectorCategory | undefined,
        limit: body.limit,
        minScore: body.minScore,
      });
      return { success: true, data: results, results, count: results.length };
    } catch (err) {
      logger.error({ err }, "语义搜索失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  /** POST /knowledge/hybrid-search — 混合搜索 */
  app.post("/hybrid-search", async (request, reply) => {
    try {
      const body = hybridSearchSchema.parse(request.body);
      const results = await hybridSearch({
        tenantId: request.tenantId,
        query: body.query,
        keywords: body.keywords,
        category: body.category as VectorCategory | undefined,
        limit: body.limit,
      });
      return { success: true, data: results, results, count: results.length };
    } catch (err) {
      logger.error({ err }, "混合搜索失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  // ====== 审核管线 ======

  /** POST /knowledge/audit — 单条审核入库 */
  app.post("/audit", async (request, reply) => {
    try {
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
    } catch (err) {
      logger.error({ err }, "审核入库失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  /** POST /knowledge/audit/batch — 批量审核入库 */
  app.post("/audit/batch", async (request, reply) => {
    try {
      const body = request.body as { items?: unknown[] } | unknown[];
      const rawItems = Array.isArray(body) ? body : (body as { items?: unknown[] }).items;
      const items = z.array(auditSchema).parse(rawItems);
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
        total: items.length,
        accepted: result.accepted,
        rejected: result.rejected,
        results: [...result.accepted, ...result.rejected],
      };
    } catch (err) {
      logger.error({ err }, "批量审核入库失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  // ====== 冷启动 ======

  /** POST /knowledge/cold-start — 触发冷启动流程 */
  app.post("/cold-start", async (request, reply) => {
    try {
      const body = coldStartSchema.parse(request.body);

      // 行业名映射：英文 → 中文
      const industry = INDUSTRY_NAME_MAP[body.industry.toLowerCase()] || body.industry;

      // seedCompetitors 统一为字符串数组
      const seedCompetitors = body.seedCompetitors?.map((item) =>
        typeof item === "string" ? item : item.name
      );

      const config: ColdStartConfig = {
        tenantId: request.tenantId,
        ...body,
        industry,
        seedCompetitors,
      };
      const progress = await runColdStart(config);
      return { success: true, data: progress };
    } catch (err) {
      logger.error({ err }, "冷启动流程失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });

  // ====== 统计 ======

  /** GET /knowledge/stats — 各子库统计 */
  app.get("/stats", async (request, reply) => {
    try {
      const stats = await getStats(request.tenantId);
      const categories = Object.keys(stats);
      const total = Object.values(stats).reduce((sum, s) => sum + s.pgCount, 0);
      return { success: true, data: stats, categories, total, count: categories.length };
    } catch (err) {
      logger.error({ err }, "获取知识库统计失败");
      return reply.status(500).send({ success: false, error: "操作失败，请稍后重试" });
    }
  });
}
