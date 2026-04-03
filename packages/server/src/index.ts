import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
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
import { dashboardRoutes } from "./routes/dashboard.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { errorHandler } from "./middleware/error.js";
import { getProviders } from "./services/ai/provider-factory.js";
import { initializeSkills } from "./services/skills/index.js";
import { startContentWorker } from "./services/task/content-worker.js";
import { registerTaskWebSocket } from "./services/task/progress-ws.js";
import { closeQueues } from "./services/task/queue.js";
import { taskRoutes } from "./routes/tasks.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { dataCollectionRoutes } from "./routes/data-collection.js";
import { contentEngineRoutes } from "./routes/content-engine.js";

async function bootstrap() {
  const app = Fastify({ logger: false });

  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_EXPIRES_IN } });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.addHook("onRequest", async (request) => {
    logger.info({ method: request.method, url: request.url }, "← 请求");
  });
  app.setErrorHandler(errorHandler);

  // 公开路由
  await app.register(healthRoutes, { prefix: `${env.API_PREFIX}/health` });
  await app.register(async (authApp) => {
    await authApp.register(rateLimit, { max: 10, timeWindow: "1 minute" });
    await authApp.register(authRoutes, { prefix: `${env.API_PREFIX}/auth` });
  });

  // 需认证路由
  await app.register(async (protectedApp) => {
    protectedApp.addHook("onRequest", authMiddleware);
    protectedApp.addHook("onRequest", tenantMiddleware);
    await protectedApp.register(tenantRoutes, { prefix: `${env.API_PREFIX}/tenant` });
    await protectedApp.register(async (chatApp) => {
      await chatApp.register(rateLimit, { max: 20, timeWindow: "1 minute" });
      await chatApp.register(chatRoutes, { prefix: `${env.API_PREFIX}/chat` });
    });
    await protectedApp.register(contentRoutes, { prefix: `${env.API_PREFIX}/content` });
    await protectedApp.register(keywordRoutes, { prefix: `${env.API_PREFIX}/keywords` });
    await protectedApp.register(journalRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(topicRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(workflowRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(wechatRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(accountRoutes, { prefix: `${env.API_PREFIX}` });
    await protectedApp.register(knowledgeRoutes, { prefix: `${env.API_PREFIX}/knowledge` });
    await protectedApp.register(dashboardRoutes, { prefix: `${env.API_PREFIX}/dashboard` });
    await protectedApp.register(taskRoutes, { prefix: `${env.API_PREFIX}/tasks` });
    await protectedApp.register(dataCollectionRoutes, { prefix: `${env.API_PREFIX}/data-collection` });
    await protectedApp.register(contentEngineRoutes, { prefix: `${env.API_PREFIX}/content-engine` });
  });

  // 初始化 AI 提供商
  const providers = getProviders();
  logger.info(`🤖 AI模型: 贵模型 ${providers.expensive.length}个, 便宜模型 ${providers.cheap.length}个`);

  // 初始化技能注册
  initializeSkills();

  // 注册 WebSocket 进度推送
  registerTaskWebSocket(app);

  // 启动后台 Worker
  const contentWorker = startContentWorker();

  // 启动 BullMQ 调度器（爬虫 + 热点 + 竞品 + 知识采集）
  startScheduler();

  // Graceful shutdown
  const shutdown = async () => {
    await stopScheduler();
    await contentWorker.close();
    await closeQueues();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

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
