/**
 * 6-20 权限中间件: 按 Permission 拦截路由。依赖 authMiddleware 先设 request.user(JWT), 排在它之后挂。
 *   权限永远从 request.user.role 在服务端现算 —— 绝不读客户端传来的 permissions, 防越权。
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { hasPermission, type Permission } from "../permissions/permissions.js";
import { logger } from "../config/logger.js";

/** 要求拥有某一权限。 */
export function requirePermission(permission: Permission) {
  return async function permissionMiddleware(request: FastifyRequest, reply: FastifyReply) {
    const role = request.user?.role;
    if (!hasPermission(role, permission)) {
      logger.warn({ userId: request.user?.userId, role, permission, path: request.url }, "权限不足, 拒绝访问");
      return reply.code(403).send({ code: "FORBIDDEN", message: "无权限访问该功能" });
    }
  };
}

/** 要求拥有 anyOf 中任意一个权限(如销售看板: read_all 或 read_assigned 都可进)。 */
export function requireAnyPermission(...permissions: Permission[]) {
  return async function anyPermissionMiddleware(request: FastifyRequest, reply: FastifyReply) {
    const role = request.user?.role;
    if (!permissions.some((p) => hasPermission(role, p))) {
      logger.warn({ userId: request.user?.userId, role, permissions, path: request.url }, "权限不足(anyOf), 拒绝访问");
      return reply.code(403).send({ code: "FORBIDDEN", message: "无权限访问该功能" });
    }
  };
}
