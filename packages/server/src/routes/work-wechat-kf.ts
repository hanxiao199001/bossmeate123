/**
 * B-kf 管理端 API（挂 /admin 前缀，JWT 保护区内 + adminOnlyMiddleware）
 *
 *   PUT    /admin/work-wechat/config            — 保存企微配置（含微信客服 Secret，加密落库）
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
import { sendKfText } from "../services/work-wechat/kf-client.js";
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
