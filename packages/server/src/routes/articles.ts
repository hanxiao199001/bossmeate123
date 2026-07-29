/**
 * PR Q.0：article 用户主动操作路由（拆按钮：用户在 ContentDetailPage 手动点
 * "🎬 生成视频" 后调本路由触发 video script 生成；不再走 chat.ts auto-bridge）。
 *
 * PR #140 (5-14)：新增 POST /:id/generate-dvh-video — 用户主动触发 article → 阿里数字人视频。
 * 前端 wire 留 PR #141 (UI tile + batch 调度 + 工时对比页)。
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../middleware/permission.js";
import { eq, and, or } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents, platformAccounts } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { triggerVideoFromArticle } from "../services/skills/auto-video-bridge.js";
import { getProvider } from "../services/ai/provider-factory.js";
import {
  triggerDvhFromArticle,
  TEMPLATE_AVATAR_VOICE_MAP,
  isRealMode,
  type TemplateId,
} from "../services/digital-human/index.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";

export async function articlesRoutes(app: FastifyInstance) {
  // POST /articles/:id/generate-video — 用户手动触发 article → video script 生成
  app.post("/:id/generate-video", { preHandler: requirePermission("content.write") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [article] = await db
      .select()
      .from(contents)
      .where(and(
        eq(contents.id, id),
        // 跟 publishToAccounts (PR #143) 一致：放开 system 推荐文章，让用户能从推荐 feed 触发
        or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      ))
      .limit(1);
    if (!article || article.type !== "article") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "article 不存在" });
    }
    const journalId = (article.metadata as { journalId?: unknown } | null)?.journalId;
    if (typeof journalId !== "string" || journalId.length === 0) {
      return reply.code(400).send({
        code: "NO_JOURNAL_ID",
        message: "article 未关联 journalId，无法生成视频（多发生在 V6 DB 未命中走 AI 合成的场景）",
      });
    }
    const provider = getProvider("expensive") || getProvider("cheap");
    if (!provider) {
      return reply.code(503).send({ code: "NO_PROVIDER", message: "无可用 AI provider" });
    }
    void triggerVideoFromArticle({
      provider,
      db,
      journalId,
      tenantId: request.tenantId,
      userId: request.user.userId,
      articleContentId: article.id,
      conversationId: article.conversationId ?? null,
    });
    logger.info({ articleId: id, journalId }, "Q.0 user-triggered article→video");
    return { code: "OK", data: { articleId: id, journalId, status: "triggered" } };
  });

  // POST /articles/:id/generate-dvh-video — 用户手动触发 article → 阿里数字人视频 (PR #140)
  app.post("/:id/generate-dvh-video", { preHandler: requirePermission("content.write") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { templateId?: string; accountId?: string; voiceId?: string; backgroundUrl?: string } | null) || {};

    const [article] = await db
      .select()
      .from(contents)
      .where(and(
        eq(contents.id, id),
        // 跟 publishToAccounts (PR #143) 一致：放开 system 推荐文章，让用户能从推荐 feed 触发
        or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      ))
      .limit(1);
    if (!article || article.type !== "article") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "article 不存在" });
    }

    const metaTemplateId = (article.metadata as { templateId?: string } | null)?.templateId;
    let templateId = body.templateId || metaTemplateId;
    // 7-10 音色库: 单次生成临时换音色 — body.voiceId(库内 voice_id) 优先于账号绑定音色
    const { sanitizeVoiceOverride } = await import("../services/voice/catalog-utils.js");
    let clonedVoiceId: string | undefined = sanitizeVoiceOverride(body.voiceId); // 6-26 该账号克隆音色 / 7-10 临时覆盖
    // 6-19 防查重: 指定目标账号且该号绑了数字人形象 → 用账号形象(不同号不同形象)。
    if (body.accountId) {
      try {
        const [acc] = await db.select({ dvhTemplate: platformAccounts.dvhTemplate, clonedVoiceId: platformAccounts.clonedVoiceId }).from(platformAccounts)
          .where(and(eq(platformAccounts.id, body.accountId), eq(platformAccounts.tenantId, request.tenantId))).limit(1);
        if (acc?.dvhTemplate) templateId = acc.dvhTemplate;
        if (!clonedVoiceId && acc?.clonedVoiceId) clonedVoiceId = acc.clonedVoiceId; // 6-26 用该号自己的声音(无临时覆盖时)
      } catch { /* 用默认 */ }
    }
    // PR-X2: 改目录解析 — 支持 config 扩展的自定义形象 key
    const { resolveAvatarVoice } = await import("../services/digital-human/template-mapping.js");
    if (!templateId || !(await resolveAvatarVoice(templateId))) {
      return reply.code(400).send({
        code: "NO_TEMPLATE_ID",
        message: `templateId 缺失或不在形象目录中 (${templateId ?? "null"})`,
      });
    }

    if (isRealMode() && (!process.env.DVH_TENANT_ID || !process.env.DVH_APP_ID)) {
      return reply.code(503).send({
        code: "NO_DVH",
        message: "DVH_REAL_MODE=true 但 DVH_TENANT_ID / DVH_APP_ID 缺失",
      });
    }

    // 7-29 背景图: 只收系统图库 / 我们自己桶里的图 / "none"(显式黑底) —— 外部 URL 未过内容审核, 拒。
    //   实际可达性在 submit 之前还有一道 HEAD 预检(见 background-library.assertBackgroundReachable)。
    let backgroundUrl: string | undefined;
    if (typeof body.backgroundUrl === "string" && body.backgroundUrl.trim()) {
      const { validateGenerationBackgroundUrl } = await import("../services/digital-human/background-library.js");
      const v = await validateGenerationBackgroundUrl(body.backgroundUrl);
      if (!v.ok) return reply.code(400).send({ code: "BAD_BACKGROUND_URL", message: v.message });
      backgroundUrl = v.value;
    }

    // PR-Z4 套餐闸: 到期/月视频配额
    {
      const { checkBilling, logBillingDenied } = await import("../services/billing/plan.js");
      const bill = await checkBilling(request.tenantId, "generate_video");
      if (!bill.allowed) {
        logBillingDenied(request.tenantId, "generate_video", bill.reason);
        return reply.code(403).send({ code: "BILLING_LIMIT", message: bill.reason });
      }
    }

    // PR-W1 预算闸前置: fire-and-forget 之前先查, 超限给用户看得见的 403 而不是静默不出片
    {
      const { checkBudget, estimateDvhCents } = await import("../services/billing/cost-ledger.js");
      const meta = article.metadata as { videoScript?: string } | null;
      const narration = meta?.videoScript ?? "x".repeat(300); // 没脚本按 90 秒保守预估
      const gate = await checkBudget(request.tenantId, estimateDvhCents(narration));
      if (!gate.allowed) {
        return reply.code(403).send({ code: "BUDGET_EXCEEDED", message: gate.reason });
      }
    }

    void triggerDvhFromArticle({
      db,
      tenantId: request.tenantId,
      userId: request.user.userId,
      articleContentId: article.id,
      templateId: templateId as TemplateId,
      conversationId: article.conversationId ?? null,
      journalId: (article.metadata as { journalId?: string } | null)?.journalId,
      clonedVoiceId, // 6-26 该号克隆音色 → DVH 用本人声音
      ...(backgroundUrl ? { backgroundUrl } : {}), // 7-29 本次生成的背景图
    });
    logger.info(
      { articleId: id, templateId, backgroundUrl, realMode: isRealMode() },
      "PR #140 user-triggered article→DVH",
    );
    return { code: "OK", data: { articleId: id, templateId, status: "triggered", realMode: isRealMode() } };
  });
}
