/**
 * B-kf 管理端 API（挂 /admin 前缀，JWT 保护区内 + adminOnlyMiddleware）
 *
 *   PUT    /admin/work-wechat/config            — 保存企微配置（含微信客服 Secret，加密落库）
 *   GET    /admin/kf/stats                      — 概览统计（今日/近N天聚合 + 按天序列 + "没答上"清单）
 *   GET    /admin/kf/conversations              — 会话列表（分页 + 最后一条消息摘要）
 *   GET    /admin/kf/conversations/:id/messages — 消息流
 *   POST   /admin/kf/conversations/:id/mode     — 切 auto/manual
 *   POST   /admin/kf/conversations/:id/reply    — 人工回复（走 sendKfText）
 *   GET/POST/PUT/DELETE /admin/kf/faqs          — FAQ CRUD
 *
 * 复用：encryptCredentials（凭证加密，同 accounts.ts）、sendKfText（kf-client）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { workWechatConfigs, kfConversations, kfMessages, kfFaqs } from "../models/schema.js";
import { adminOnlyMiddleware } from "../middleware/admin-only.js";
import { encryptCredentials } from "../utils/crypto.js";
import { sendKfText, pingKfCredential } from "../services/work-wechat/kf-client.js";
import { getKfStats } from "../services/work-wechat/kf-stats.js";
import { chat } from "../services/ai/chat-service.js";
import { env } from "../config/env.js";
import { normalizeImportItems, parseFaqText, dedupWithinBatch, faqDedupKey } from "../services/work-wechat/kf-faq-import.js";
import {
  formatConversationForLlm, conversationHasHumanAnswer, buildSuggestSystemPrompt,
  buildSuggestUserMessage, parseSuggestions, type KfMsgLite,
} from "../services/work-wechat/kf-faq-suggest.js";
import { logger } from "../config/logger.js";

const configSchema = z.object({
  corpId: z.string().min(1).max(100),
  agentId: z.string().min(1).max(50),
  token: z.string().min(1).max(100),
  encodingAesKey: z.string().length(43).optional(), // 企微固定 43 字符；更新时可不传（保留旧值）
  kfSecret: z.string().min(1).optional(),           // 微信客服 Secret；可后补
  agentSecret: z.string().min(1).optional(),        // 自建应用 Secret（handoff 通知运营）；可后补，省略保留旧值
  notifyUserIds: z.string().max(500).optional(),    // 通知接收人 userid 逗号分隔；省略保留旧值，传空串=清空(回退@all)
});

const faqSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  enabled: z.boolean().default(true),
  sort: z.number().int().default(0),
});

export async function workWechatKfRoutes(app: FastifyInstance) {
  // 全部 admin-only（外层 protectedApp 已挂 auth + tenant 中间件）
  app.addHook("onRequest", adminOnlyMiddleware);

  /** PUT /admin/work-wechat/config — 企微配置 upsert（此前仓库无写入口，回调只读） */
  app.put("/work-wechat/config", async (request, reply) => {
    try {
      const body = configSchema.parse(request.body);
      const tenantId = request.tenantId;
      const [existing] = await db.select().from(workWechatConfigs).where(eq(workWechatConfigs.tenantId, tenantId)).limit(1);

      if (existing) {
        await db.update(workWechatConfigs).set({
          corpId: body.corpId,
          agentId: body.agentId,
          token: body.token,
          ...(body.encodingAesKey ? { encodingAesKeyEnc: encryptCredentials(body.encodingAesKey) } : {}),
          ...(body.kfSecret ? { kfSecretEnc: encryptCredentials(body.kfSecret) } : {}),
          ...(body.agentSecret ? { agentSecretEnc: encryptCredentials(body.agentSecret) } : {}),
          ...(body.notifyUserIds !== undefined ? { notifyUserids: body.notifyUserIds.trim() || null } : {}),
          updatedAt: new Date(),
        }).where(eq(workWechatConfigs.id, existing.id));
        return reply.send({ code: "ok", data: { updated: true } });
      }

      if (!body.encodingAesKey) {
        return reply.status(400).send({ code: "invalid_request", message: "首次配置必须提供 encodingAesKey" });
      }
      await db.insert(workWechatConfigs).values({
        tenantId,
        corpId: body.corpId,
        agentId: body.agentId,
        token: body.token,
        encodingAesKeyEnc: encryptCredentials(body.encodingAesKey),
        kfSecretEnc: body.kfSecret ? encryptCredentials(body.kfSecret) : undefined,
        agentSecretEnc: body.agentSecret ? encryptCredentials(body.agentSecret) : undefined,
        notifyUserids: body.notifyUserIds?.trim() || undefined,
      });
      return reply.send({ code: "ok", data: { created: true } });
    } catch (err) {
      if (err instanceof z.ZodError) return reply.status(400).send({ code: "invalid_request", message: err.errors[0]?.message });
      logger.error({ err }, "保存企微配置失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /admin/work-wechat/config — 配置状态（安全：Secret 只回"是否已配置"布尔，绝不回显明文）。
   * 前端「企微设置」tab 用来预填 + 显示 ●●●●已配置 占位 + 客服账号 open_kfid。
   */
  app.get("/work-wechat/config", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const [cfg] = await db.select().from(workWechatConfigs).where(eq(workWechatConfigs.tenantId, tenantId)).limit(1);
      if (!cfg) {
        return reply.send({ code: "ok", data: { configured: false } });
      }
      // 库里已出现过的客服账号 open_kfid（从会话里 distinct）——帮老板确认"哪个客服号接进来了"
      const kfids = await db.selectDistinct({ openKfid: kfConversations.openKfid }).from(kfConversations)
        .where(eq(kfConversations.tenantId, tenantId)).limit(20);
      return reply.send({
        code: "ok",
        data: {
          configured: true,
          corpId: cfg.corpId,
          agentId: cfg.agentId,
          token: cfg.token,
          hasEncodingAesKey: true, // 首次配置强制要求，存在即已配
          hasKfSecret: !!cfg.kfSecretEnc,
          hasAgentSecret: !!cfg.agentSecretEnc,
          notifyUserids: cfg.notifyUserids ?? "",
          openKfids: kfids.map((k) => k.openKfid),
          updatedAt: cfg.updatedAt,
        },
      });
    } catch (err) {
      logger.error({ err }, "读取企微配置状态失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /** GET /admin/work-wechat/test — 测试连接（gettoken 验证 corpId + kfSecret），只读不落库 */
  app.get("/work-wechat/test", async (request, reply) => {
    try {
      const result = await pingKfCredential(request.tenantId);
      return reply.send({ code: "ok", data: result });
    } catch (err) {
      logger.error({ err }, "企微测试连接失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /admin/kf/stats?days=7 — 概览统计（运营每天第一眼）。
   * 返回：今日/近 N 天聚合数卡 + 按天序列（柱状图）+ "AI 没答上"清单（补 FAQ 依据）+ agentSecretConfigured 布尔。
   * 权限同本文件其余接口（外层 auth+tenant + adminOnlyMiddleware），聚合查询全部经 kf_conversations.tenant_id 隔离。
   */
  app.get("/kf/stats", async (request, reply) => {
    try {
      const q = request.query as { days?: string };
      const days = Math.max(1, Math.min(30, parseInt(q.days ?? "7") || 7));
      const data = await getKfStats(request.tenantId, days);
      return reply.send({ code: "ok", data });
    } catch (err) {
      logger.error({ err }, "kf 概览统计查询失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /** GET /admin/kf/conversations — 分页 + 最后一条消息摘要 */
  app.get("/kf/conversations", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const q = request.query as { page?: string; pageSize?: string; mode?: string };
      const page = Math.max(1, parseInt(q.page ?? "1") || 1);
      const pageSize = Math.max(1, Math.min(100, parseInt(q.pageSize ?? "20") || 20));

      const conditions = [eq(kfConversations.tenantId, tenantId)];
      if (q.mode === "auto" || q.mode === "manual") conditions.push(eq(kfConversations.mode, q.mode));
      const whereExpr = and(...conditions);

      const [{ count: total }] = await db.select({ count: sql<number>`count(*)::int` }).from(kfConversations).where(whereExpr);
      const items = await db.select({
        id: kfConversations.id,
        openKfid: kfConversations.openKfid,
        externalUserid: kfConversations.externalUserid,
        mode: kfConversations.mode,
        lastMsgAt: kfConversations.lastMsgAt,
        createdAt: kfConversations.createdAt,
        // 最后一条消息摘要（截 80 字）+ 方向，列表页展示用
        lastMsgContent: sql<string | null>`(
          SELECT left(m.content, 80) FROM ${kfMessages} m
          WHERE m.conversation_id = ${kfConversations.id}
          ORDER BY m.created_at DESC LIMIT 1
        )`,
        lastMsgDirection: sql<string | null>`(
          SELECT m.direction FROM ${kfMessages} m
          WHERE m.conversation_id = ${kfConversations.id}
          ORDER BY m.created_at DESC LIMIT 1
        )`,
      }).from(kfConversations).where(whereExpr)
        .orderBy(desc(sql`coalesce(${kfConversations.lastMsgAt}, ${kfConversations.createdAt})`))
        .limit(pageSize).offset((page - 1) * pageSize);

      return reply.send({ code: "ok", data: { items, total, page, pageSize } });
    } catch (err) {
      logger.error({ err }, "kf 会话列表查询失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /** 会话归属校验（防跨租户越权），复用于下面 3 个 :id 接口 */
  async function loadConv(tenantId: string, id: string) {
    const [conv] = await db.select().from(kfConversations)
      .where(and(eq(kfConversations.id, id), eq(kfConversations.tenantId, tenantId))).limit(1);
    return conv ?? null;
  }

  /** GET /admin/kf/conversations/:id/messages */
  app.get<{ Params: { id: string } }>("/kf/conversations/:id/messages", async (request, reply) => {
    try {
      const conv = await loadConv(request.tenantId, request.params.id);
      if (!conv) return reply.status(404).send({ code: "not_found", message: "会话不存在" });
      const messages = await db.select().from(kfMessages)
        .where(eq(kfMessages.conversationId, conv.id))
        .orderBy(asc(kfMessages.createdAt)).limit(200);
      return reply.send({ code: "ok", data: { conversation: conv, messages } });
    } catch (err) {
      logger.error({ err }, "kf 消息查询失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /** POST /admin/kf/conversations/:id/mode — 切 auto/manual */
  app.post<{ Params: { id: string }; Body: { mode?: string } }>("/kf/conversations/:id/mode", async (request, reply) => {
    try {
      const mode = request.body?.mode;
      if (mode !== "auto" && mode !== "manual") {
        return reply.status(400).send({ code: "invalid_request", message: "mode 必须是 auto 或 manual" });
      }
      const conv = await loadConv(request.tenantId, request.params.id);
      if (!conv) return reply.status(404).send({ code: "not_found", message: "会话不存在" });
      await db.update(kfConversations).set({ mode }).where(eq(kfConversations.id, conv.id));
      return reply.send({ code: "ok", data: { id: conv.id, mode } });
    } catch (err) {
      logger.error({ err }, "kf 切换模式失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /** POST /admin/kf/conversations/:id/reply — 人工回复（不强制 manual：人工插话也允许） */
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/kf/conversations/:id/reply", async (request, reply) => {
    try {
      const text = request.body?.text?.trim();
      if (!text) return reply.status(400).send({ code: "invalid_request", message: "回复内容不能为空" });
      const conv = await loadConv(request.tenantId, request.params.id);
      if (!conv) return reply.status(404).send({ code: "not_found", message: "会话不存在" });

      const sent = await sendKfText(conv.openKfid, conv.externalUserid, text);
      const [saved] = await db.insert(kfMessages).values({
        conversationId: conv.id,
        direction: "out",
        msgType: "text",
        content: text,
        aiAction: "manual", // 人工发送标记
      }).returning();
      await db.update(kfConversations).set({ lastMsgAt: new Date() }).where(eq(kfConversations.id, conv.id));

      // sent=false 通常是 48h 窗口/条数限制（kf-client 已记日志），前端提示但消息保留在记录里
      return reply.send({ code: "ok", data: { message: saved, sent } });
    } catch (err) {
      logger.error({ err }, "kf 人工回复失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  // ============ FAQ CRUD ============

  app.get("/kf/faqs", async (request, reply) => {
    try {
      const items = await db.select().from(kfFaqs)
        .where(eq(kfFaqs.tenantId, request.tenantId))
        .orderBy(asc(kfFaqs.sort), asc(kfFaqs.createdAt));
      return reply.send({ code: "ok", data: { items } });
    } catch (err) {
      logger.error({ err }, "kf FAQ 列表失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  app.post("/kf/faqs", async (request, reply) => {
    try {
      const body = faqSchema.parse(request.body);
      const [created] = await db.insert(kfFaqs).values({ tenantId: request.tenantId, ...body }).returning();
      return reply.send({ code: "ok", data: created });
    } catch (err) {
      if (err instanceof z.ZodError) return reply.status(400).send({ code: "invalid_request", message: err.errors[0]?.message });
      logger.error({ err }, "kf FAQ 创建失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /admin/kf/faqs/import — FAQ 批量导入（让老板"自己教客服"）。
   * body: { items?: [{question, answer, enabled?, sort?}], text?: string, mode?: "skip"|"update" }
   *   - items 优先（前端 CSV/Excel/文本解析后的预览数组）；无 items 时用 text（粘贴文本，后端 parseFaqText 兜底解析）
   *   - mode=skip（默认）：同 question 已存在则跳过；mode=update：同 question 覆盖答案
   * 返回 { imported, updated, skipped, invalid, duplicated, total }。导入即进 kf_faqs，responder 自动检索（不改应答链路）。
   */
  app.post("/kf/faqs/import", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { items?: unknown; text?: string; mode?: string };
      const mode = body.mode === "update" ? "update" : "skip";

      // 归一到 ParsedFaqItem[]：items 优先，否则解析 text
      let normalized: { items: ReturnType<typeof normalizeImportItems>["items"]; invalid: number };
      if (Array.isArray(body.items)) {
        normalized = normalizeImportItems(body.items);
      } else if (typeof body.text === "string" && body.text.trim()) {
        const parsed = parseFaqText(body.text);
        normalized = { items: parsed.items, invalid: parsed.errors.length };
      } else {
        return reply.status(400).send({ code: "invalid_request", message: "请提供 items 数组或 text 文本" });
      }

      if (normalized.items.length === 0) {
        return reply.status(400).send({ code: "invalid_request", message: "没有解析到有效的问答（每行需含问题和答案）" });
      }
      if (normalized.items.length > env.KF_FAQ_IMPORT_MAX) {
        return reply.status(400).send({ code: "invalid_request", message: `单次最多导入 ${env.KF_FAQ_IMPORT_MAX} 条，当前 ${normalized.items.length} 条` });
      }

      // 批内去重
      const { items, duplicated } = dedupWithinBatch(normalized.items);

      // 库内去重：拉现有 question → key→id 映射
      const existing = await db.select({ id: kfFaqs.id, question: kfFaqs.question }).from(kfFaqs)
        .where(eq(kfFaqs.tenantId, request.tenantId));
      const keyToId = new Map<string, string>();
      for (const e of existing) keyToId.set(faqDedupKey(e.question), e.id);

      let imported = 0, updated = 0, skipped = 0, failed = 0;
      for (const it of items) {
        const key = faqDedupKey(it.question);
        const existId = keyToId.get(key);
        try {
          if (existId) {
            if (mode === "update") {
              await db.update(kfFaqs).set({ answer: it.answer, updatedAt: new Date() }).where(eq(kfFaqs.id, existId));
              updated++;
            } else {
              skipped++;
            }
          } else {
            const [created] = await db.insert(kfFaqs).values({
              tenantId: request.tenantId, question: it.question, answer: it.answer, enabled: it.enabled, sort: it.sort,
            }).returning({ id: kfFaqs.id });
            if (created) keyToId.set(key, created.id); // 防同批后续重复再插
            imported++;
          }
        } catch (e) {
          logger.warn({ err: e instanceof Error ? e.message : e, question: it.question.slice(0, 40) }, "kf FAQ 导入单条失败");
          failed++;
        }
      }

      return reply.send({
        code: "ok",
        data: { imported, updated, skipped, invalid: normalized.invalid, duplicated, failed, total: items.length },
      });
    } catch (err) {
      logger.error({ err }, "kf FAQ 批量导入失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /admin/kf/faq-suggestions — 从历史对话学习：扫最近人工回复的会话 → LLM 提炼候选 FAQ（不落库）。
   * 成本护栏：会话数 ≤ KF_SUGGEST_MAX_CONVERSATIONS（默认 30），单次一趟 LLM；任何失败兜底返回空，不 500。
   * 采纳走 POST /admin/kf/faqs/import（人过目后入库）—— 合规"人在环"学习，不做黑箱自动学。
   */
  app.get("/kf/faq-suggestions", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const maxConv = env.KF_SUGGEST_MAX_CONVERSATIONS;

      // 取"有人工答过"的会话(codex P2): 原按 mode=manual 过滤会漏——运营答完把会话恢复自动模式后 mode≠manual,
      //   但对话里确实留了人工答案(正是该学的)。改按"存在人工回复消息"选, 不看当前模式(与 conversationHasHumanAnswer 同口径)。
      const convs = await db.select({ id: kfConversations.id }).from(kfConversations)
        .where(and(
          eq(kfConversations.tenantId, tenantId),
          sql`EXISTS (SELECT 1 FROM ${kfMessages} WHERE ${kfMessages.conversationId} = ${kfConversations.id} AND ${kfMessages.direction} = 'out' AND ${kfMessages.aiAction} IN ('manual', 'human_wecom') AND ${kfMessages.msgType} = 'text')`,
        ))
        .orderBy(desc(sql`coalesce(${kfConversations.lastMsgAt}, ${kfConversations.createdAt})`))
        .limit(maxConv);

      if (convs.length === 0) {
        return reply.send({ code: "ok", data: { suggestions: [], scanned: 0, message: "暂无人工接管过的会话可供学习" } });
      }

      // 逐会话取消息 → 只留"有客户问 + 有人工答"的，格式化
      const conversationTexts: string[] = [];
      for (const c of convs) {
        const rows = await db.select({
          direction: kfMessages.direction, content: kfMessages.content,
          aiAction: kfMessages.aiAction, msgType: kfMessages.msgType,
        }).from(kfMessages).where(eq(kfMessages.conversationId, c.id))
          .orderBy(desc(kfMessages.createdAt)).limit(60);
        // codex P2: 长会话(>60条)人工答案往往在后段, 原 asc+limit(60) 只取最旧 60 条会漏掉 → 取最新 60 条再转回时间正序
        const msgs = (rows as KfMsgLite[]).reverse();
        if (!conversationHasHumanAnswer(msgs)) continue;
        const text = formatConversationForLlm(msgs);
        if (text) conversationTexts.push(text);
      }

      if (conversationTexts.length === 0) {
        return reply.send({ code: "ok", data: { suggestions: [], scanned: convs.length, message: "扫描的会话里没有可提炼的人工问答" } });
      }

      const maxCandidates = Math.min(30, conversationTexts.length * 2);
      let suggestions;
      try {
        const res = await chat({
          tenantId,
          userId: "kf-faq-suggest",
          conversationId: `faq-suggest-${tenantId}`,
          message: buildSuggestUserMessage(conversationTexts),
          skillType: "customer_service", // 走 Qwen-Plus（红线 #3 model-router）
          systemPrompt: buildSuggestSystemPrompt(maxCandidates),
        });
        suggestions = parseSuggestions(res.content);
      } catch (e) {
        // LLM 失败兜底：不阻塞，返回空 + 提示
        logger.warn({ err: e instanceof Error ? e.message : e, tenantId }, "kf FAQ 建议 LLM 提炼失败");
        return reply.send({ code: "ok", data: { suggestions: [], scanned: conversationTexts.length, message: "AI 提炼暂时不可用，请稍后重试" } });
      }

      return reply.send({ code: "ok", data: { suggestions, scanned: conversationTexts.length } });
    } catch (err) {
      logger.error({ err }, "kf FAQ 建议生成失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  app.put<{ Params: { id: string } }>("/kf/faqs/:id", async (request, reply) => {
    try {
      const body = faqSchema.partial().parse(request.body);
      const [updated] = await db.update(kfFaqs).set({ ...body, updatedAt: new Date() })
        .where(and(eq(kfFaqs.id, request.params.id), eq(kfFaqs.tenantId, request.tenantId)))
        .returning();
      if (!updated) return reply.status(404).send({ code: "not_found", message: "FAQ 不存在" });
      return reply.send({ code: "ok", data: updated });
    } catch (err) {
      if (err instanceof z.ZodError) return reply.status(400).send({ code: "invalid_request", message: err.errors[0]?.message });
      logger.error({ err }, "kf FAQ 更新失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  app.delete<{ Params: { id: string } }>("/kf/faqs/:id", async (request, reply) => {
    try {
      const [deleted] = await db.delete(kfFaqs)
        .where(and(eq(kfFaqs.id, request.params.id), eq(kfFaqs.tenantId, request.tenantId)))
        .returning({ id: kfFaqs.id });
      if (!deleted) return reply.status(404).send({ code: "not_found", message: "FAQ 不存在" });
      return reply.send({ code: "ok", data: deleted });
    } catch (err) {
      logger.error({ err }, "kf FAQ 删除失败");
      return reply.status(500).send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });
}
