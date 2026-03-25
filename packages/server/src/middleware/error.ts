import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";

/**
 * 全局错误处理器
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  logger.error(
    {
      err: error,
      method: request.method,
      url: request.url,
    },
    "请求处理异常"
  );

  // Zod 验证错误
  if (error.validation) {
    return reply.code(400).send({
      code: "VALIDATION_ERROR",
      message: "参数校验失败",
      details: error.validation,
    });
  }

  // 业务错误（自定义 statusCode）
  if (error.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send({
      code: error.code || "CLIENT_ERROR",
      message: error.message,
    });
  }

  // 未知错误，不暴露内部信息
  return reply.code(500).send({
    code: "INTERNAL_ERROR",
    message: "服务内部错误，请稍后重试",
  });
}
