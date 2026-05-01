import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../models/db.js";
import { tenants, users } from "../models/schema.js";
import { logger } from "../config/logger.js";

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
  app.get("/members", async (request) => {
    const members = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
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
}
