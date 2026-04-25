import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { randomUUID } from "crypto";

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenant.js";
import { chatRoutes } from "./routes/chat.js";
import { contentRoutes } from "./routes/content.js";
import { healthRoutes } from "./routes/health.js";
import { keywordRoutes } from "./routes/keywords.js";
import { salesRoutes } from "./routes/sales.js";
import { journalRoutes } from "./routes/journals.js";
import { topicRoutes } from "./routes/topic.js";
import { workflowRoutes } from "./routes/workflow.js";
import { wechatRoutes } from "./routes/wechat.js";
import { accountRoutes } from "./routes/accounts.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { apiDocsRoutes } from "./routes/api-docs.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { errorHandler } from "./middleware/error.js";
import { getProviders } from "./services/ai/provider-factory.js";
import { initializeSkills } from "./services/skills/index.js";
import { startContentWorker } from "./services/task/content-worker.js";
import { startPublishWorker, stopPublishWorker } from "./services/task/publish-worker.js";
import { registerTaskWebSocket } from "./services/task/progress-ws.js";
import { closeQueues } from "./services/task/queue.js";
import { taskRoutes } from "./routes/tasks.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { dataCollectionRoutes } from "./routes/data-collection.js";
import { contentEngineRoutes } from "./routes/content-engine.js";
import { recommendationRoutes } from "./routes/recommendations.js";
import { agentRoutes } from "./routes/agent-status.js";
import { videoRoutes } from "./routes/video.js";
import { startVideoWorker } from "./services/task/video-worker.js";
import { agentRegistry } from "./services/agents/base/registry.js";
import { KnowledgeEngine } from "./services/agents/knowledge-engine.js";
import { ContentDirector } from "./services/agents/content-director.js";
import { Orchestrator } from "./services/agents/orchestrator.js";

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRASH] unhandledRejection:", reason);
  console.error("[CRASH] promise:", promise);
});
process.on("uncaughtException", (err) => {
  console.error("[CRASH] uncaughtException:", err);
});

async function bootstrap() {
  const app = Fastify({ logger: false });

  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  // gzip 压缩（可选依赖）
  try {
    // @ts-ignore — optional dependency
    const compressMod = await import("@fastify/compress");
    await app.register(compressMod.default, { global: true });
    logger.info("gzip 压缩已启用");
  } catch {
    logger.info("@fastify/compress 未安装，跳过 gzip 压缩");
  }
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_EXPIRES_IN } });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
    skipOnError: true,
    // 轮询接口完全跳过限流（Dashboard 每秒多次轮询会迅速耗尽配额）
    allowList: (req) => {
      const url = req.url ?? "";
      return url.includes("/agents/orchestrator/progress") ||
        url.includes("/agents/status") ||
        url.includes("/agents/daily-plan");
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `请求过于频繁，请 ${Math.ceil(context.ttl / 1000)} 秒后再试`,
    }),
  });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // 静态文件服务：LocalStorage 的 /storage/... URL
  try {
    const fastifyStatic = await import("@fastify/static");
    const { join, resolve } = await import("node:path");
    const storageRoot = resolve(env.UPLOAD_DIR, "storage");
    await app.register(fastifyStatic.default, {
      root: storageRoot,
      prefix: "/storage/",
      decorateReply: false,
    });
    logger.info({ root: storageRoot }, "静态文件服务 /storage/ 已注册");
  } catch (err) {
    logger.warn({ err }, "静态文件服务注册失败");
  }

  app.addHook("onRequest", async (request, reply) => {
    // Generate or reuse requestId for distributed tracing
    const requestId = request.headers["x-request-id"] as string || randomUUID();
    request.id = requestId;

    // Add X-Request-Id to response header
    reply.header("X-Request-Id", requestId);

    logger.info({ method: request.method, url: request.url, requestId }, "← 请求");
  });
  app.setErrorHandler(errorHandler);

  // 公开路由
  await app.register(healthRoutes, { prefix: `${env.API_PREFIX}/health` });
  await app.register(apiDocsRoutes, { prefix: `${env.API_PREFIX}/docs` });
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
    await protectedApp.register(recommendationRoutes, { prefix: `${env.API_PREFIX}/recommendations` });
    await protectedApp.register(agentRoutes, { prefix: `${env.API_PREFIX}/agents` });
    await protectedApp.register(salesRoutes, { prefix: `${env.API_PREFIX}/sales` });
    await protectedApp.register(videoRoutes, { prefix: `${env.API_PREFIX}/video` });
  });

  // 初始化 AI 提供商
  const providers = getProviders();
  logger.info(`🤖 AI模型: 贵模型 ${providers.expensive.length}个, 便宜模型 ${providers.cheap.length}个`);

  // 初始化技能注册
  initializeSkills();

  // 注册 WebSocket 进度推送
  registerTaskWebSocket(app);

  // 注册 Agent
  agentRegistry.register(new KnowledgeEngine());
  agentRegistry.register(new ContentDirector());
  agentRegistry.register(new Orchestrator());
  logger.info(`Agent 注册完成: ${agentRegistry.list().map(a => a.name).join(", ")}`);

  // V3 事件驱动型 Agent：订阅 EventBus 进入被动消费模式
  try {
    const { qualityCheckerAgent } = await import("./services/agents/quality-checker.js");
    const { publishManagerAgent } = await import("./services/agents/publish-manager.js");
    const baseCfg = { concurrency: 1, maxRetries: 3, timeoutMs: 300_000 };
    await qualityCheckerAgent.initialize(baseCfg);
    await publishManagerAgent.initialize(baseCfg);

    if (env.SALES_AGENT_ENABLED) {
      const { conversationAgent } = await import("./services/sales/conversation-agent.js");
      await conversationAgent.initialize(baseCfg);
      logger.info("✅ V3 事件驱动 Agent 已就绪: quality-checker, publish-manager, conversation-agent");
    } else {
      logger.info("⏸️  SALES_AGENT_ENABLED=false，已跳过 ConversationAgent 初始化");
      logger.info("✅ V3 事件驱动 Agent 已就绪: quality-checker, publish-manager");
    }

    if (env.USE_CEO_AGENT) {
      const { CeoAgent } = await import("./services/agents/ceo-agent.js");
      const ceo = new CeoAgent();
      await ceo.initialize(baseCfg);
      logger.info("✅ CEO Agent 已启用（USE_CEO_AGENT=true）");
    }
  } catch (err) {
    logger.error({ err }, "V3 Agent 初始化失败，继续启动主服务");
  }

  // 启动后台 Worker
  const contentWorker = startContentWorker();
  const videoWorker = startVideoWorker();

  // 启动发布 Worker
  startPublishWorker();

  // 启动 BullMQ 调度器（爬虫 + 热点 + 竞品 + 知识采集 + Agent）
  startScheduler();

  // Graceful shutdown
  const shutdown = async () => {
    await stopScheduler();
    stopPublishWorker();
    await agentRegistry.shutdownAll();
    try {
      const { eventBus } = await import("./services/event-bus/index.js");
      await eventBus.shutdown();
    } catch {}
    await contentWorker.close();
    await videoWorker.close();
    try {
      const { closeBrowser } = await import("./services/video/html-renderer.js");
      await closeBrowser();
    } catch {}
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
