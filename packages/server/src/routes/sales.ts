/**
 * 销售 CRM（AI 客服管理台）API
 *
 * 路由前缀：/api/v1/sales
 *  GET    /leads              — 查询 lead 列表（分页/筛选/搜索 + 未读数）
 *  GET    /leads/:id          — lead 详情 + 最近 100 条消息，顺便清零未读
 *  POST   /leads/:id/messages — 人工发送 outbound 消息（需接管中）
 *  POST   /leads/:id/takeover — 接管对话：AI → human
 *  POST   /leads/:id/release  — 交还对话：human → AI
 *  GET    /stats              — 顶部徽章统计
 *  PATCH  /leads/:id          — 手动改 stage / 分配 / profile
 */

import type { FastifyInstance } from "fastify";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../models/db.js";
import { leads, salesMessages } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { requireAnyPermission } from "../middleware/permission.js";
import { hasPermission } from "../permissions/permissions.js";
import { env } from "../config/env.js";

type LeadStage =
  | "new"
  | "contacted"
  | "qualified"
  | "negotiating"
  | "won"
  | "lost"
  | "need_human";

type HandoverMode = "ai" | "human";

export async function salesRoutes(app: FastifyInstance) {
  // 功能开关：SALES_AGENT_ENABLED=false 时整个模块下线
  app.addHook("onRequest", async (_req, reply) => {
    if (!env.SALES_AGENT_ENABLED) {
      return reply.status(503).send({
        code: "sales_module_disabled",
        message: "AI 销售对话模块暂未开放",
      });
    }
  });

  /**
   * GET /leads — 列表 + 未读数
   */
  app.get("/leads", { preHandler: requireAnyPermission("sales.read_all", "sales.read_assigned") }, async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const query = request.query as {
        stage?: string;
        handoverMode?: string;
        search?: string;
        page?: string;
        pageSize?: string;
      };

      const page = Math.max(1, query.page ? parseInt(query.page) : 1);
      const pageSize = Math.max(
        1,
        Math.min(100, query.pageSize ? parseInt(query.pageSize) : 20)
      );
      const offset = (page - 1) * pageSize;

      const conditions = [eq(leads.tenantId, tenantId)];
      // 6-20: 无 read_all(普通销售)只看分配给自己的线索
      if (!hasPermission(request.user.role, "sales.read_all")) conditions.push(eq(leads.assignedUserId, request.user.userId));
      if (query.stage) {
        // 5-21 P3: stage 支持逗号分隔多值 (热 tab = qualified,negotiating,need_human)
        const stages = query.stage.split(",").map((s) => s.trim()).filter(Boolean);
        if (stages.length === 1) conditions.push(eq(leads.stage, stages[0]));
        else if (stages.length > 1) conditions.push(inArray(leads.stage, stages));
      }
      if (query.handoverMode)
        conditions.push(eq(leads.handoverMode, query.handoverMode));
      if (query.search && query.search.trim()) {
        const kw = `%${query.search.trim()}%`;
        const searchCond = or(
          ilike(leads.name, kw),
          ilike(leads.phone, kw),
          ilike(leads.email, kw)
        );
        if (searchCond) conditions.push(searchCond);
      }

      const whereExpr = and(...conditions);

      // 总数
      const [{ count: total }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(leads)
        .where(whereExpr);

      // 列表 + 未读数（inbound 且 created_at > last_read_at，或 last_read_at 为空算全部 inbound 未读）
      const rows = await db
        .select({
          id: leads.id,
          tenantId: leads.tenantId,
          channel: leads.channel,
          externalId: leads.externalId,
          name: leads.name,
          contactId: leads.contactId,
          phone: leads.phone,
          email: leads.email,
          sourceContentId: leads.sourceContentId,
          profile: leads.profile,
          stage: leads.stage,
          intentScore: leads.intentScore,
          assignedUserId: leads.assignedUserId,
          lastMessageAt: leads.lastMessageAt,
          handoverMode: leads.handoverMode,
          takenOverBy: leads.takenOverBy,
          takenOverAt: leads.takenOverAt,
          lastReadAt: leads.lastReadAt,
          createdAt: leads.createdAt,
          updatedAt: leads.updatedAt,
          unreadCount: sql<number>`(
            SELECT count(*)::int FROM ${salesMessages}
            WHERE ${salesMessages.leadId} = ${leads.id}
              AND ${salesMessages.direction} = 'inbound'
              AND (${leads.lastReadAt} IS NULL OR ${salesMessages.createdAt} > ${leads.lastReadAt})
          )`,
        })
        .from(leads)
        .where(whereExpr)
        .orderBy(
          desc(sql`coalesce(${leads.lastMessageAt}, ${leads.createdAt})`)
        )
        .limit(pageSize)
        .offset(offset);

      return reply.send({
        code: "ok",
        data: {
          items: rows,
          total,
          page,
          pageSize,
        },
      });
    } catch (err) {
      logger.error({ err }, "获取销售线索列表失败");
      return reply
        .status(500)
        .send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /leads/:id — 详情 + 消息 + 清零未读
   */
  app.get<{ Params: { id: string } }>("/leads/:id", { preHandler: requireAnyPermission("sales.read_all", "sales.read_assigned") }, async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const { id } = request.params;

      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)))
        .limit(1);

      if (!lead) {
        return reply
          .status(404)
          .send({ code: "not_found", message: "线索不存在" });
      }
      // 6-20: 无 read_all 且非本人线索 → 拒绝(防越权看/改他人客户)
      if (!hasPermission(request.user.role, "sales.read_all") && lead.assignedUserId !== request.user.userId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "无权访问该客户" });
      }

      const messages = await db
        .select()
        .from(salesMessages)
        .where(
          and(
            eq(salesMessages.leadId, id),
            eq(salesMessages.tenantId, tenantId)
          )
        )
        .orderBy(asc(salesMessages.createdAt))
        .limit(100);

      // 清零未读
      await db
        .update(leads)
        .set({ lastReadAt: new Date() })
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));

      return reply.send({
        code: "ok",
        data: { lead, messages },
      });
    } catch (err) {
      logger.error({ err }, "获取线索详情失败");
      return reply
        .status(500)
        .send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /leads/:id/messages — 人工发送
   */
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    "/leads/:id/messages",
    { preHandler: requireAnyPermission("sales.write_all", "sales.write_assigned") },
    async (request, reply) => {
      try {
        const tenantId = request.tenantId;
        const { id } = request.params;
        const { content } = request.body ?? { content: "" };

        if (!content || !content.trim()) {
          return reply
            .status(400)
            .send({ code: "invalid_request", message: "消息内容不能为空" });
        }

        const [lead] = await db
          .select()
          .from(leads)
          .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)))
          .limit(1);

        if (!lead) {
          return reply
            .status(404)
            .send({ code: "not_found", message: "线索不存在" });
        }
        if (!hasPermission(request.user.role, "sales.read_all") && lead.assignedUserId !== request.user.userId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "无权访问该客户" });
        }

        if (lead.handoverMode !== "human") {
          return reply
            .status(400)
            .send({ code: "invalid_state", message: "请先接管对话" });
        }

        const now = new Date();
        const [saved] = await db
          .insert(salesMessages)
          .values({
            tenantId,
            leadId: id,
            direction: "outbound",
            kind: "text",
            content: content.trim(),
            isAiGenerated: false,
            sentAt: now,
            metadata: { operatorId: request.user.userId },
          })
          .returning();

        await db
          .update(leads)
          .set({ lastMessageAt: now, updatedAt: now })
          .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));

        return reply.send({ code: "ok", data: saved });
      } catch (err) {
        logger.error({ err }, "人工发送销售消息失败");
        return reply
          .status(500)
          .send({ code: "error", message: "操作失败，请稍后重试" });
      }
    }
  );

  /**
   * POST /leads/:id/takeover — 接管
   */
  app.post<{ Params: { id: string } }>(
    "/leads/:id/takeover",
    { preHandler: requireAnyPermission("sales.write_all", "sales.write_assigned") },
    async (request, reply) => {
      try {
        const tenantId = request.tenantId;
        const { id } = request.params;

        const [lead] = await db
          .select()
          .from(leads)
          .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)))
          .limit(1);

        if (!lead) {
          return reply
            .status(404)
            .send({ code: "not_found", message: "线索不存在" });
        }
        if (!hasPermission(request.user.role, "sales.read_all") && lead.assignedUserId !== request.user.userId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "无权访问该客户" });
        }

        const now = new Date();
        await db
          .update(leads)
          .set({
            handoverMode: "human",
            takenOverBy: request.user.userId,
            takenOverAt: lead.handoverMode === "human" ? lead.takenOverAt : now,
            updatedAt: now,
          })
          .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));

        return reply.send({ code: "ok", data: { handoverMode: "human" } });
      } catch (err) {
        logger.error({ err }, "接管对话失败");
        return reply
          .status(500)
          .send({ code: "error", message: "操作失败，请稍后重试" });
      }
    }
  );

  /**
   * POST /leads/:id/release — 交还 AI
   */
  app.post<{ Params: { id: string } }>(
    "/leads/:id/release",
    { preHandler: requireAnyPermission("sales.write_all", "sales.write_assigned") },
    async (request, reply) => {
      try {
        const tenantId = request.tenantId;
        const { id } = request.params;

        const [lead] = await db
          .select()
          .from(leads)
          .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)))
          .limit(1);

        if (!lead) {
          return reply
            .status(404)
            .send({ code: "not_found", message: "线索不存在" });
        }
        if (!hasPermission(request.user.role, "sales.read_all") && lead.assignedUserId !== request.user.userId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "无权访问该客户" });
        }

        await db
          .update(leads)
          .set({
            handoverMode: "ai",
            takenOverBy: null,
            takenOverAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));

        return reply.send({ code: "ok", data: { handoverMode: "ai" } });
      } catch (err) {
        logger.error({ err }, "交还 AI 失败");
        return reply
          .status(500)
          .send({ code: "error", message: "操作失败，请稍后重试" });
      }
    }
  );

  /**
   * GET /stats — 顶部徽章统计
   */
  app.get("/stats", { preHandler: requireAnyPermission("sales.read_all", "sales.read_assigned") }, async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      // 5-21 P3 销售雷达: 24h (todayNew) + 30d (monthConverted) 滚动窗口避时区坑;
      // weekWarm 改 stock 池语义 (无时间窗) 见下方
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [{ totalLeads }] = await db
        .select({ totalLeads: sql<number>`count(*)::int` })
        .from(leads)
        .where(eq(leads.tenantId, tenantId));

      const [{ humanModeCount }] = await db
        .select({ humanModeCount: sql<number>`count(*)::int` })
        .from(leads)
        .where(
          and(eq(leads.tenantId, tenantId), eq(leads.handoverMode, "human"))
        );

      const [{ needHumanCount }] = await db
        .select({ needHumanCount: sql<number>`count(*)::int` })
        .from(leads)
        .where(
          and(
            eq(leads.tenantId, tenantId),
            eq(leads.stage, "need_human"),
            eq(leads.handoverMode, "ai")
          )
        );

      // 有未读的 lead 数
      const [{ unreadLeads }] = await db
        .select({
          unreadLeads: sql<number>`count(DISTINCT ${salesMessages.leadId})::int`,
        })
        .from(salesMessages)
        .innerJoin(leads, eq(leads.id, salesMessages.leadId))
        .where(
          and(
            eq(leads.tenantId, tenantId),
            eq(salesMessages.direction, "inbound"),
            or(
              isNull(leads.lastReadAt),
              gt(salesMessages.createdAt, leads.lastReadAt)
            )!
          )
        );

      // 5-21 P3 销售雷达 3 数字 (additive, 老 caller 不破)
      const [{ todayNew }] = await db
        .select({ todayNew: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(eq(leads.tenantId, tenantId), eq(leads.stage, "new"), gte(leads.createdAt, dayAgo)));

      // 5-21 P3 决策 (d): weekWarm 改 stock 池语义 (砍 7d 时间窗) — "当前在热 stage 的 stock 池"
      // 字段名 weekWarm 保留为技术债 (post-demo 重命名 activeWarm), 不破前端契约
      const [{ weekWarm }] = await db
        .select({ weekWarm: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(
          eq(leads.tenantId, tenantId),
          inArray(leads.stage, ["qualified", "negotiating", "need_human"]),
        ));

      const [{ monthConverted }] = await db
        .select({ monthConverted: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(eq(leads.tenantId, tenantId), eq(leads.stage, "won"), gte(leads.updatedAt, monthAgo)));

      return reply.send({
        code: "ok",
        data: {
          totalLeads,
          unreadLeads,
          needHumanCount,
          humanModeCount,
          // P3 销售雷达 hero 3 大数字
          todayNew,
          weekWarm,
          monthConverted,
        },
      });
    } catch (err) {
      logger.error({ err }, "获取销售统计失败");
      return reply
        .status(500)
        .send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * PATCH /leads/:id — 更新 stage / 分配 / profile
   */
  app.patch<{
    Params: { id: string };
    Body: {
      stage?: LeadStage;
      assignedUserId?: string | null;
      profile?: Record<string, unknown>;
    };
  }>("/leads/:id", { preHandler: requireAnyPermission("sales.write_all", "sales.write_assigned", "sales.assign") }, async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const { id } = request.params;
      const body = request.body ?? {};

      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)))
        .limit(1);

      if (!lead) {
        return reply
          .status(404)
          .send({ code: "not_found", message: "线索不存在" });
      }
      // 6-20: 无 read_all 且非本人线索 → 拒绝(防越权看/改他人客户)
      if (!hasPermission(request.user.role, "sales.read_all") && lead.assignedUserId !== request.user.userId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "无权访问该客户" });
      }

      const patch: Partial<typeof leads.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.stage) patch.stage = body.stage;
      // 6-20: 改派线索(改 assignedUserId)需 sales.assign 权限, 普通销售不能把线索甩给别人
      if (body.assignedUserId !== undefined) {
        if (!hasPermission(request.user.role, "sales.assign")) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "无权分配/改派线索" });
        }
        patch.assignedUserId = body.assignedUserId;
      }
      if (body.profile !== undefined) patch.profile = body.profile;

      await db
        .update(leads)
        .set(patch)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));

      const [updated] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)))
        .limit(1);

      return reply.send({ code: "ok", data: updated });
    } catch (err) {
      logger.error({ err }, "更新线索失败");
      return reply
        .status(500)
        .send({ code: "error", message: "操作失败，请稍后重试" });
    }
  });
}

// 保留未用标识以便未来扩展
export type { HandoverMode, LeadStage };
