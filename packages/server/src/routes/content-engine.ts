/**
 * P4 内容生成引擎 API 路由
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

const formatEnum = z.enum([
  "spoken", "article", "video_script", "infographic",
  "long_graphic", "short_video", "audio", "interactive",
]);

export async function contentEngineRoutes(app: FastifyInstance) {

  // ===== 8种形式生成 =====

  app.post("/generate", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const userId = request.user.userId;
    const schema = z.object({
      topic: z.string().min(2),
      format: formatEnum,
      audience: z.string().optional(),
      tone: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      platform: z.string().optional(),
      wordCount: z.number().optional(),
      extraRequirements: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const { generateByFormat } = await import("../services/content-engine/format-generators.js");
    return generateByFormat({ tenantId, userId, ...body });
  });

  app.post("/generate/multi", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const userId = request.user.userId;
    const schema = z.object({
      topic: z.string().min(2),
      formats: z.array(formatEnum).min(1).max(8),
      audience: z.string().optional(),
      tone: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      platform: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const { generateMultiFormat } = await import("../services/content-engine/format-generators.js");
    return generateMultiFormat({ tenantId, userId, topic: body.topic, audience: body.audience, tone: body.tone, keywords: body.keywords, platform: body.platform }, body.formats);
  });

  // ===== 文章 Pipeline =====

  app.post("/pipeline/article", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const userId = request.user.userId;
    const schema = z.object({
      topic: z.string().min(2),
      audience: z.string().optional(),
      tone: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      platform: z.string().optional(),
      wordCount: z.number().optional(),
      articleType: z.string().optional(),
      variants: z.number().int().min(1).max(3).optional().default(1),
    });
    const body = schema.parse(request.body);
    const { runArticlePipeline } = await import("../services/content-engine/article-pipeline.js");
    return runArticlePipeline(tenantId, userId, body);
  });

  // ===== 内容日历 =====

  app.post("/calendar/plan", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({
      columnName: z.string().min(1),
      frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]),
      platforms: z.array(z.string()),
      contentFormats: z.array(formatEnum),
      topicPool: z.array(z.string()),
    });
    const body = schema.parse(request.body);
    const { createColumnPlan } = await import("../services/content-engine/content-calendar.js");
    return createColumnPlan(tenantId, body);
  });

  app.get("/calendar/view", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const query = schema.parse(request.query);
    const { getCalendarView } = await import("../services/content-engine/content-calendar.js");
    return getCalendarView(tenantId, query.startDate, query.endDate);
  });

  app.post("/calendar/trigger", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { triggerDueCalendarEntries } = await import("../services/content-engine/content-calendar.js");
    return triggerDueCalendarEntries(tenantId);
  });

  app.post("/calendar/hot-topics", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { generateHotTopicSuggestions } = await import("../services/content-engine/content-calendar.js");
    return generateHotTopicSuggestions(tenantId);
  });

  // ===== 质检 V2 =====

  app.post("/quality-check-v2", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const schema = z.object({
      title: z.string().min(1),
      body: z.string().min(50),
      platform: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const { qualityCheckV2 } = await import("../services/content-engine/quality-check-v2.js");
    return qualityCheckV2({ tenantId, ...body });
  });

  // ===== 内容复用 =====

  app.post("/repurpose", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const userId = request.user.userId;
    const schema = z.object({
      sourceContentId: z.string().uuid(),
      type: z.enum(["platform_adapt", "format_convert", "series_extend", "summary", "localize"]),
      targetFormat: formatEnum.optional(),
      targetPlatform: z.string().optional(),
      instructions: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const { repurposeContent } = await import("../services/content-engine/content-repurpose.js");
    const result = await repurposeContent({ tenantId, userId, ...body });
    if (!result) return reply.status(404).send({ error: "原始内容不存在" });
    return result;
  });

  app.get("/derivation-chain/:contentId", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const { contentId } = request.params as { contentId: string };
    const { getDerivationChain } = await import("../services/content-engine/content-repurpose.js");
    return getDerivationChain(tenantId, contentId);
  });

  // ===== T4-3-5: 模板列表 + per-tenant 偏好分布（前端 ContentDetailPage / Settings 用） =====

  app.get("/templates", async (_request: FastifyRequest, _reply: FastifyReply) => {
    const { listTemplates } = await import("../services/skills/template-registry.js");
    const templates = listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
    }));
    return { code: "OK", data: { templates } };
  });

  app.get("/template-preferences", async (request: FastifyRequest, _reply: FastifyReply) => {
    const tenantId = request.tenantId;
    const [{ getTemplatePreferences }, { listTemplates }] = await Promise.all([
      import("../services/skills/template-preference.js"),
      import("../services/skills/template-registry.js"),
    ]);

    const prefs = await getTemplatePreferences(tenantId);
    const allTemplates = listTemplates();

    const enriched = allTemplates.map((t) => {
      const p = prefs.find((x) => x.templateId === t.id);
      return {
        templateId: t.id,
        name: t.name,
        icon: t.icon,
        description: t.description,
        selectedCount: p?.selectedCount ?? 0,
        rejectedCount: p?.rejectedCount ?? 0,
        weight: p?.weight ?? 0,
      };
    });

    const totalSelections = enriched.reduce((s, e) => s + e.selectedCount, 0);
    return { code: "OK", data: { preferences: enriched, totalSelections } };
  });
}
