import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";

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
    reply.code(403).send({
      code: "NO_TENANT",
      message: "未关联租户，请联系管理员",
    });
    return;
  }

  // 将 tenantId 挂载到 request，后续查询都用这个做数据隔离
  request.tenantId = tenantId;

  logger.debug({ tenantId, userId: request.user.userId }, "租户上下文已加载");
}

// 扩展 Fastify 类型
declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}
