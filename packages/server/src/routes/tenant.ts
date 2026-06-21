import type { FastifyInstance, FastifyReply } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../models/db.js";
import { tenants, users, tenantInvites } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { requirePermission } from "../middleware/permission.js";

/** Day 2 PR A: 租户级联系信息（admin 可改），shape 与 shunshi-style 模板 ContactMeta 对齐。 */
const contactMetaSchema = z.object({
  contactName: z.string().min(1).max(50),
  wechatId: z.string().max(50).optional().nullable(),
  workingHours: z.string().max(100).optional().nullable(),
  qrCodeUrl: z.string().url().max(500).optional().nullable(),
  email: z.string().email().max(100).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
});

function requireAdmin(request: { user?: { role?: string } }, reply: FastifyReply): boolean {
  const role = request.user?.role;
  if (role !== "owner" && role !== "admin") {
    reply.code(403).send({ code: "FORBIDDEN", message: "仅 owner / admin 可改租户配置" });
    return false;
  }
  return true;
}

export async function tenantRoutes(app: FastifyInstance) {
  /**
   * GET /tenant/info - 获取当前租户信息（含 contactMeta，Day 2 PR A）
   */
  app.get("/info", async (request) => {
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, request.tenantId))
      .limit(1);

    if (!tenant) {
      return { code: "NOT_FOUND", message: "租户不存在" };
    }

    return {
      code: "OK",
      data: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        contactMeta: tenant.contactMeta ?? null,
      },
    };
  });

  /**
   * PATCH /tenant/contact - 更新当前租户的 contact_meta（Day 2 PR A）。
   * owner / admin 才能改。整段替换（v1 简单语义；v2 如要部分字段更新再支持 PATCH-merge）。
   */
  app.patch("/contact", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const parsed = contactMetaSchema.parse(
        (request.body as { contactMeta?: unknown })?.contactMeta,
      );
      const next = {
        ...parsed,
        lastUpdatedAt: new Date().toISOString(),
      };
      const [updated] = await db
        .update(tenants)
        .set({ contactMeta: next, updatedAt: new Date() })
        .where(eq(tenants.id, request.tenantId))
        .returning({ id: tenants.id, contactMeta: tenants.contactMeta });
      if (!updated) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "租户不存在" });
      }
      logger.info({ tenantId: request.tenantId }, "PR A: contact_meta 已更新");
      return { code: "OK", data: { contactMeta: updated.contactMeta } };
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return reply.code(400).send({
          code: "VALIDATION_ERROR",
          message: "contactMeta 字段校验失败",
          data: err.issues,
        });
      }
      logger.error({ err }, "PR A: 更新 contact_meta 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "更新失败" });
    }
  });

  /**
   * GET /tenant/members - 获取租户成员列表
   */
  app.get("/members", { preHandler: requirePermission("members.manage") }, async (request) => {
    const members = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.tenantId, request.tenantId));

    return {
      code: "OK",
      data: members,
    };
  });

  // 可邀请的角色(owner 不通过邀请产生; admin 仅 owner 可授)
  const INVITABLE = new Set(["admin", "content_operator", "sales_director", "sales", "finance_viewer"]);

  /**
   * GET /tenant/invites - 待接受的邀请列表
   */
  app.get("/invites", { preHandler: requirePermission("members.manage") }, async (request) => {
    const rows = await db.select({
      id: tenantInvites.id, phone: tenantInvites.phone, role: tenantInvites.role,
      status: tenantInvites.status, expiresAt: tenantInvites.expiresAt, createdAt: tenantInvites.createdAt,
    }).from(tenantInvites)
      .where(and(eq(tenantInvites.tenantId, request.tenantId), eq(tenantInvites.status, "pending")))
      .orderBy(desc(tenantInvites.createdAt));
    return { code: "OK", data: rows };
  });

  /**
   * POST /tenant/invites - 邀请员工(按手机号), 员工验证码登录时自动入职绑角色。
   */
  app.post("/invites", { preHandler: requirePermission("members.manage") }, async (request, reply) => {
    const body = z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"), role: z.string() }).parse(request.body);
    if (!INVITABLE.has(body.role)) return reply.code(400).send({ code: "INVALID_ROLE", message: "不可邀请该角色" });
    if (body.role === "admin" && request.user.role !== "owner") {
      return reply.code(403).send({ code: "FORBIDDEN", message: "仅老板可邀请管理员" });
    }
    // 已是本租户成员?
    const [existMember] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.tenantId, request.tenantId), eq(users.phone, body.phone))).limit(1);
    if (existMember) return reply.code(409).send({ code: "ALREADY_MEMBER", message: "该手机号已是公司成员" });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7天有效
    // 同租户同手机已有 pending → 刷新角色/有效期; 否则新建
    const [exist] = await db.select({ id: tenantInvites.id }).from(tenantInvites)
      .where(and(eq(tenantInvites.tenantId, request.tenantId), eq(tenantInvites.phone, body.phone), eq(tenantInvites.status, "pending"))).limit(1);
    if (exist) {
      await db.update(tenantInvites).set({ role: body.role, expiresAt, updatedAt: new Date() }).where(eq(tenantInvites.id, exist.id));
    } else {
      await db.insert(tenantInvites).values({
        tenantId: request.tenantId, phone: body.phone, role: body.role,
        invitedByUserId: request.user.userId, expiresAt,
      });
    }
    logger.info({ tenantId: request.tenantId, phone: body.phone, role: body.role, by: request.user.userId }, "邀请员工");
    return { code: "OK", data: { phone: body.phone, role: body.role, expiresAt } };
  });

  /**
   * PATCH /tenant/members/:id - 改成员角色/启停。owner 保护: 仅 owner 可动 owner; 不能降/禁最后一个 owner。
   */
  app.patch("/members/:id", { preHandler: requirePermission("members.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ role: z.string().optional(), isActive: z.boolean().optional() }).parse(request.body);

    const [target] = await db.select().from(users)
      .where(and(eq(users.id, id), eq(users.tenantId, request.tenantId))).limit(1);
    if (!target) return reply.code(404).send({ code: "NOT_FOUND", message: "成员不存在" });

    // 涉及 owner(目标是 owner 或要设为 owner)→ 仅 owner 可操作
    if ((target.role === "owner" || body.role === "owner") && request.user.role !== "owner") {
      return reply.code(403).send({ code: "FORBIDDEN", message: "仅老板可调整老板账号" });
    }
    if (body.role && body.role !== "owner" && !INVITABLE.has(body.role)) {
      return reply.code(400).send({ code: "INVALID_ROLE", message: "非法角色" });
    }
    // 降级/禁用最后一个 owner 的保护
    const demotingOwner = target.role === "owner" && ((body.role && body.role !== "owner") || body.isActive === false);
    if (demotingOwner) {
      const owners = await db.select({ id: users.id }).from(users)
        .where(and(eq(users.tenantId, request.tenantId), eq(users.role, "owner"), eq(users.isActive, true)));
      if (owners.length <= 1) return reply.code(400).send({ code: "LAST_OWNER", message: "不能降级/停用唯一的老板账号" });
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.role) patch.role = body.role;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    await db.update(users).set(patch).where(eq(users.id, id));
    logger.info({ tenantId: request.tenantId, target: id, patch, by: request.user.userId }, "调整成员");
    return { code: "OK", data: { id, ...patch } };
  });
}
