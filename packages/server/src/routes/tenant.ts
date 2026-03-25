import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { tenants, users } from "../models/schema.js";

export async function tenantRoutes(app: FastifyInstance) {
  /**
   * GET /tenant/info - 获取当前租户信息
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
      },
    };
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
