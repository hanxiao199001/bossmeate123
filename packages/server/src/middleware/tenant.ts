import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";
import { db } from "../models/db.js";
import { tenants } from "../models/schema.js";
import { eq } from "drizzle-orm";

// 租户存在性缓存（避免每次请求都查库）
const tenantCache = new Map<string, { validUntil: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

/**
 * 多租户中间件
 * 从 JWT 中提取 tenantId，确保数据隔离
 */
export async function tenantMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { tenantId } = request.user;

  if (!tenantId) {
    logger.warn({ userId: request.user.userId }, "缺少租户信息");
    return reply.code(403).send({
      code: "NO_TENANT",
      message: "未关联租户，请联系管理员",
    });
  }

  // 验证租户是否存在且活跃（带缓存）
  const cached = tenantCache.get(tenantId);
  if (!cached || cached.validUntil < Date.now()) {
    const [tenant] = await db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant || tenant.status !== "active") {
      logger.warn({ tenantId }, "租户不存在或已停用");
      return reply.code(403).send({
        code: "TENANT_INACTIVE",
        message: "租户不存在或已停用",
      });
    }

    tenantCache.set(tenantId, { validUntil: Date.now() + CACHE_TTL });
  }

  request.tenantId = tenantId;
  logger.debug({ tenantId, userId: request.user.userId }, "租户上下文已加载");
}

// 扩展 Fastify 类型
declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}
