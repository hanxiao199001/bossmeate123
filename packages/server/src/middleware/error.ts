import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { logger } from "../config/logger.js";

/**
 * 全局错误处理器
 */
export function errorHandler(
  error: FastifyError | ZodError | Error,
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

  // Zod 校验错误（来自路由中的 schema.parse()）
  if (error instanceof ZodError) {
    return reply.code(400).send({
      code: "VALIDATION_ERROR",
      message: "参数校验失败",
      details: error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      })),
    });
  }

  // Fastify 原生验证错误
  if ("validation" in error && (error as FastifyError).validation) {
    return reply.code(400).send({
      code: "VALIDATION_ERROR",
      message: "参数校验失败",
      details: (error as FastifyError).validation,
    });
  }

  // 业务错误（自定义 statusCode）
  const fastifyErr = error as FastifyError;
  if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
    return reply.code(fastifyErr.statusCode).send({
      code: fastifyErr.code || "CLIENT_ERROR",
      message: fastifyErr.message,
    });
  }

  // 未知错误，不暴露内部信息
  return reply.code(500).send({
    code: "INTERNAL_ERROR",
    message: "服务内部错误，请稍后重试",
  });
}
