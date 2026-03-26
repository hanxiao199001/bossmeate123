/**
 * 关键词中心 API
 *
 * 路由：
 * GET  /keywords             — 获取关键词列表（分页+筛选）
 * GET  /keywords/today       — 获取今日关键词报告
 * GET  /keywords/platforms   — 获取已注册爬虫平台
 * POST /keywords/crawl       — 手动触发一次全平台抓取
 * POST /keywords/crawl/:platform — 手动触发单平台抓取
 */

import type { FastifyInstance } from "fastify";
import { crawlAll, crawlPlatform, getRegisteredPlatforms } from "../services/crawler/index.js";
import {
  analyzeKeywords,
  getTodayKeywords,
  getKeywords,
} from "../services/agents/keyword-analyzer.js";
import { logger } from "../config/logger.js";
import type { PlatformName } from "../services/crawler/types.js";

export async function keywordRoutes(app: FastifyInstance) {
  /**
   * GET /keywords — 获取关键词列表
   */
  app.get("/", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };
    const query = request.query as {
      page?: string;
      pageSize?: string;
      platform?: string;
      category?: string;
      status?: string;
    };

    const result = await getKeywords(tenantId, {
      page: query.page ? parseInt(query.page) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize) : 50,
      platform: query.platform,
      category: query.category,
      status: query.status,
    });

    return reply.send({ code: "ok", data: result });
  });

  /**
   * GET /keywords/today — 获取今日关键词
   */
  app.get("/today", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit) : 50;

    const todayKeywords = await getTodayKeywords(tenantId, limit);

    return reply.send({
      code: "ok",
      data: {
        date: new Date().toISOString().split("T")[0],
        count: todayKeywords.length,
        keywords: todayKeywords,
      },
    });
  });

  /**
   * GET /keywords/platforms — 获取已注册爬虫平台
   */
  app.get("/platforms", async (_request, reply) => {
    const platforms = getRegisteredPlatforms();
    return reply.send({
      code: "ok",
      data: { platforms },
    });
  });

  /**
   * POST /keywords/crawl — 手动触发全平台抓取 + 分析
   */
  app.post("/crawl", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };

    logger.info({ tenantId }, "手动触发全平台热点抓取");

    // 异步执行，不阻塞响应
    const startTime = Date.now();

    try {
      // Step 1: 全平台爬虫
      const crawlerResults = await crawlAll();

      // Step 2: 关键词分析 + 入库
      const report = await analyzeKeywords(crawlerResults, tenantId);

      return reply.send({
        code: "ok",
        data: {
          ...report,
          crawlerSummary: crawlerResults.map((r) => ({
            platform: r.platform,
            success: r.success,
            itemCount: r.items.length,
            error: r.error,
          })),
          durationMs: Date.now() - startTime,
        },
      });
    } catch (err) {
      logger.error({ err }, "全平台抓取失败");
      return reply.status(500).send({
        code: "error",
        message: "抓取失败，请检查日志",
      });
    }
  });

  /**
   * POST /keywords/crawl/:platform — 手动触发单平台抓取
   */
  app.post<{ Params: { platform: string } }>(
    "/crawl/:platform",
    async (request, reply) => {
      const { tenantId } = request.user as { tenantId: string };
      const platform = request.params.platform as PlatformName;

      const registeredPlatforms = getRegisteredPlatforms();
      if (!registeredPlatforms.includes(platform)) {
        return reply.status(400).send({
          code: "error",
          message: `不支持的平台: ${platform}，可用平台: ${registeredPlatforms.join(", ")}`,
        });
      }

      logger.info({ tenantId, platform }, "手动触发单平台热点抓取");

      try {
        const result = await crawlPlatform(platform);

        // 只分析这一个平台的结果
        const report = await analyzeKeywords([result], tenantId);

        return reply.send({
          code: "ok",
          data: {
            platform,
            success: result.success,
            itemCount: result.items.length,
            report,
          },
        });
      } catch (err) {
        logger.error({ err, platform }, "单平台抓取失败");
        return reply.status(500).send({
          code: "error",
          message: `${platform} 抓取失败`,
        });
      }
    }
  );
}
