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
import { articlesRoutes } from "./routes/articles.js";
import { contentTemplatesRoutes } from "./routes/templates.js";
import { contentRoutes } from "./routes/content.js";
import { healthRoutes } from "./routes/health.js";
import { keywordRoutes } from "./routes/keywords.js";
import { salesRoutes } from "./routes/sales.js";
import { journalRoutes } from "./routes/journals.js";
import { topicRoutes } from "./routes/topic.js";
import { workflowRoutes } from "./routes/workflow.js";
import { wechatRoutes } from "./routes/wechat.js";
import { wechatCallbackRoutes } from "./routes/wechat-callback.js";
import { douyinCallbackRoutes } from "./routes/douyin-callback.js";
import { agentPublishRoutes, agentAdminRoutes } from "./routes/agent.js";
import { agentReleaseRoutes } from "./routes/agent-release.js";
import { todayRoutes } from "./routes/today.js";
import { workWechatCallbackRoutes } from "./routes/work-wechat-callback.js";
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
import { startJournalEnrichWorker } from "./services/task/journal-enrich-worker.js";
// PR P1（5-9 砍定时发布）：publish-worker.ts 已删除（功能迁移到即时发布走 publisher.ts）
import { registerTaskWebSocket } from "./services/task/progress-ws.js";
import { closeQueues } from "./services/task/queue.js";
import { taskRoutes } from "./routes/tasks.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { startWatchdog, stopWatchdog } from "./services/articles/watchdog.js";
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
  // Node 官方建议: uncaughtException 后进程状态不可信, 退出让 pm2 拉起, 避免带病僵尸运行。
  process.exit(1);
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
  // B.1: 公众号 inbound webhook（公开路径，无 JWT；签名校验在路由内做）
  await app.register(wechatCallbackRoutes, { prefix: env.API_PREFIX });
  // 抖音 OAuth 回调（公开, state HMAC 签名防伪造）
  await app.register(douyinCallbackRoutes, { prefix: env.API_PREFIX });
  // Agent-1 (B轨): 本地发布 Agent（公开注册, 自带 x-agent-token 鉴权, 不走用户 JWT）
  await app.register(agentPublishRoutes, { prefix: env.API_PREFIX });
  await app.register(agentReleaseRoutes, { prefix: env.API_PREFIX });
  // B.2: 企业微信 inbound webhook（公开路径，AES + msg_signature 在路由内做）
  await app.register(workWechatCallbackRoutes, { prefix: env.API_PREFIX });
  await app.register(async (authApp) => {
    await authApp.register(rateLimit, { max: 10, timeWindow: "1 minute" });
    await authApp.register(authRoutes, { prefix: `${env.API_PREFIX}/auth` });
  });

  // B.9: 匿名公开 onboarding 路由（无 JWT / 无 tenant，独立 rate-limit 10/IP/min）
  await app.register(async (publicApp) => {
    await publicApp.register(rateLimit, { max: 10, timeWindow: "1 minute" });
    const { publicRoutes } = await import("./routes/public.js");
    await publicApp.register(publicRoutes, { prefix: `${env.API_PREFIX}/public` });
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
    await protectedApp.register(articlesRoutes, { prefix: `${env.API_PREFIX}/articles` });
    await protectedApp.register(contentTemplatesRoutes, { prefix: `${env.API_PREFIX}/content-templates` });
    await protectedApp.register(keywordRoutes, { prefix: `${env.API_PREFIX}/keywords` });
    await protectedApp.register(journalRoutes, { prefix: `${env.API_PREFIX}` });
    // P3 AI 推荐（5-10 backend）
    const { recommendRoutes } = await import("./routes/recommend.js");
    await protectedApp.register(recommendRoutes, { prefix: `${env.API_PREFIX}` });
    // P4 批量 csv 导入（5-12 backend Day 1）
    const { batchRoutes } = await import("./routes/batch.js");
    await protectedApp.register(batchRoutes, { prefix: `${env.API_PREFIX}` });
    // P5 行业月度 cron（5-14 admin 手动 trigger）
    const { industryMonthlyRoutes } = await import("./routes/industry-monthly.js");
    await protectedApp.register(industryMonthlyRoutes, { prefix: `${env.API_PREFIX}` });
    // P6 tenant 偏好（5-15）
    const { preferencesRoutes } = await import("./routes/preferences.js");
    await protectedApp.register(preferencesRoutes, { prefix: `${env.API_PREFIX}` });
    // PR 2：期刊审计页（admin only）
    const { journalsAuditRoutes } = await import("./routes/journals-audit.js");
    await protectedApp.register(journalsAuditRoutes, { prefix: `${env.API_PREFIX}` });
    // PR #161 admin-only (workbench v2 手动生成 + bulk-distribute)
    const { adminRoutes } = await import("./routes/admin.js");
    await protectedApp.register(adminRoutes, { prefix: `${env.API_PREFIX}/admin` });
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
    // Agent-1 (B轨): Agent 设备管理 + 派单（用户 JWT）
    await protectedApp.register(agentAdminRoutes, { prefix: env.API_PREFIX });
    await protectedApp.register(todayRoutes, { prefix: env.API_PREFIX }); // PR-W2 今日驾驶舱
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
  const journalEnrichWorker = startJournalEnrichWorker();

  // 启动发布 Worker
  // PR P1：startPublishWorker 已删（即时发布走 publisher.publishToAccounts，无定时）

  // 启动 BullMQ 调度器（爬虫 + 热点 + 竞品 + 知识采集 + Agent）
  startScheduler();

  // P0-B：article 卡死 watchdog（generating 超 10min → failed，每 1min 检测）
  startWatchdog();

  // P4 批量 csv worker（5-12 backend）— 并发 5
  const { startBatchWorker } = await import("./services/batch/batch-worker.js");
  const batchWorker = startBatchWorker();

  // PR #161 (5-23) bulk-distribute worker — admin 多选批量发布
  const { startBulkDistributeWorker } = await import("./services/bulk-distribute/worker.js");
  const bulkDistributeWorker = startBulkDistributeWorker();

  // Graceful shutdown
  const shutdown = async () => {
    stopWatchdog();
    await batchWorker.close().catch(() => {});
    await bulkDistributeWorker.close().catch(() => {});
    await stopScheduler();
    // PR P1：stopPublishWorker 已删
    await agentRegistry.shutdownAll();
    try {
      const { eventBus } = await import("./services/event-bus/index.js");
      await eventBus.shutdown();
    } catch {}
    await contentWorker.close();
    await videoWorker.close();
    await journalEnrichWorker.close();
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

bootstrap().catch((e) => {
  console.error("[CRASH] bootstrap failed:", e);
  process.exit(1);
});
