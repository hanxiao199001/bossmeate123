/**
 * 7-05 多租户开通 P0 — 平台管理员白名单中间件。
 *
 * PLATFORM_ADMIN_PHONES(逗号分隔手机号, 默认空=无人可见平台功能)内的手机号才是"平台管理员",
 * 可访问 /platform/*(客户开通页等)。JWT 不带 phone, 故查 users 表取当前用户手机号比对。
 * 依赖 authMiddleware 先设 request.user, 在它之后挂。
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { users } from "../models/schema.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

/** 白名单手机号集合(每次调用即时解析, env 常驻不变, 开销可忽略)。 */
export function platformAdminPhones(): Set<string> {
  return new Set(
    (env.PLATFORM_ADMIN_PHONES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** 当前用户是否平台管理员(查 users 表拿 phone 比对白名单)。 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const allow = platformAdminPhones();
  if (allow.size === 0) return false;
  const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
  return !!u?.phone && allow.has(u.phone);
}

/** preHandler: 非平台管理员一律 403。 */
export async function platformAdminOnly(request: FastifyRequest, reply: FastifyReply) {
  const userId = request.user?.userId;
  if (!userId || !(await isPlatformAdmin(userId))) {
    logger.warn({ userId, path: request.url }, "platform-admin 路由拒绝非白名单访问");
    return reply.code(403).send({ code: "FORBIDDEN", message: "仅平台管理员可访问" });
  }
}
