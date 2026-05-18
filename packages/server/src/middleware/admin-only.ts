/**
 * 5-23 PR #161 — admin-only 中间件 (role check).
 *
 * 用于 /admin/* 路由: 限制 owner/admin 才能调。
 * 依赖 authMiddleware 先设 request.user (JWT decoded), 在它之后挂。
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";

const ADMIN_ROLES = new Set(["owner", "admin"]);

export async function adminOnlyMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const role = request.user?.role;
  if (!role || !ADMIN_ROLES.has(role)) {
    logger.warn({ userId: request.user?.userId, role, path: request.url }, "admin-only 路由拒绝非 admin 访问");
    return reply.code(403).send({
      code: "FORBIDDEN",
      message: "需要 admin 或 owner 权限",
    });
  }
}
