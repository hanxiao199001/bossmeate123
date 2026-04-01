import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenant.js";
import { chatRoutes } from "./routes/chat.js";
import { contentRoutes } from "./routes/content.js";
import { healthRoutes } from "./routes/health.js";
import { keywordRoutes } from "./routes/keywords.js";
import { journalRoutes } from "./routes/journals.js";
import { topicRoutes } from "./routes/topic.js";
import { workflowRoutes } from "./routes/workflow.js";
import { wechatRoutes } from "./routes/wechat.js";
import { accountRoutes } from "./routes/accounts.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { errorHandler } from "./middleware/error.js";
import { getProviders } from "./services/ai/provider-factory.js";

async function bootstrap() {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_EXPIRES_IN } });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.addHook("onRequest", async (request) => {
    logger.info({ method: request.method, url: request.url }, "← 请求");
  });
  app.setErrorHandler(errorHandler);

  // 公开路由
  await app.register(healthRoutes, { prefix: `${env.API_PREFIX}/health` });
  await app.register(authRoutes, { prefix: `${env.API_PREFIX}/auth` });

  // 需认证路由
  await app.register(async (protectedApp) => {
    protectedApp.addHook("onRequest", authMiddleware);
    protectedApp.addHook("onRequest", tenantMiddleware);
    await protectedApp.register(tenantRoutes, { prefix: `${env.API_PREFIX}/tenant` });
    await protectedApp.register(chatRoutes, { prefix: `${env.API_PREFIX}/chat` });
    await protectedApp.register(contentRoutes, { prefix: `${env.API_PREFIX}/content` });
    await protectedApp.register(keywordRoutes, { prefix: `${env.API_PREFIX}/keywords` });
    await protectedApp.register(journalRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(topicRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(workflowRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(wechatRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(accountRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(knowledgeRoutes, { prefix: `${env.API_PREFIX}/knowledge` });
  });

  // 初始化 AI 提供商
  const providers = getProviders();
  logger.info(`🤖 AI模型: 贵模型 ${providers.expensive.length}个, 便宜模型 ${providers.cheap.length}个`);

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`🚀 BossMate 服务启动成功 → http://0.0.0.0:${env.PORT}`);
    logger.info(`📡 API 前缀: ${env.API_PREFIX}`);
    logger.info(`🌍 环境: ${env.NODE_ENV}`);
  } catch (err) {
    logger.fatal(err, "❌ 服务启动失败");
    process.exit(1);
  }
}

bootstrap();
