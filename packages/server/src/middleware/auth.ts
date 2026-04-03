import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";

/**
 * JWT 认证中间件
 * 验证请求头中的 Bearer Token
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const decoded = await request.jwtVerify<{
      userId: string;
      tenantId: string;
      role: string;
    }>();

    // 挂载用户信息到 request
    request.user = decoded;
  } catch (err) {
    logger.warn({ err }, "认证失败");
    return reply.code(401).send({
      code: "UNAUTHORIZED",
      message: "请先登录",
    });
  }
}

// 扩展 Fastify 类型
declare module "fastify" {
  interface FastifyRequest {
    user: {
      userId: string;
      tenantId: string;
      role: string;
    };
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      userId: string;
      tenantId: string;
      role: string;
    };
    user: {
      userId: string;
      tenantId: string;
      role: string;
    };
  }
}
