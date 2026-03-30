/**
 * 关键词中心 API
 *
 * 路由：
 * GET  /keywords             — 获取关键词列表（分页+筛选）
 * GET  /keywords/today       — 获取今日关键词报告
 * GET  /keywords/trends      — 📈 获取趋势报告（exploding/rising/stable/cooling）
 * GET  /keywords/trends/:keyword — 📈 单个关键词趋势详情
 * GET  /keywords/platforms   — 获取已注册爬虫平台
 * GET  /keywords/dictionary  — 📖 获取行业词库列表
 * GET  /keywords/dictionary/categories — 📖 获取词库分类
 * POST /keywords/dictionary  — 📖 添加行业关键词
 * POST /keywords/dictionary/init — 📖 初始化预置词库
 * PATCH /keywords/dictionary/:id — 📖 更新行业关键词
 * DELETE /keywords/dictionary/:id — 📖 删除行业关键词
 * POST /keywords/crawl       — 手动触发全平台抓取
 * POST /keywords/crawl/domestic — 只抓国内核心线
 * POST /keywords/crawl/sci   — 只抓SCI线
 * POST /keywords/crawl/:platform — 手动触发单平台抓取
 * POST /keywords/clusters    — 🔥关键词聚类+标题生成
 */

import type { FastifyInstance } from "fastify";
import {
  crawlAll,
  crawlByTrack,
  crawlPlatform,
  getRegisteredPlatforms,
  getPlatformsByTrack,
} from "../services/crawler/index.js";
import {
  analyzeKeywords,
  getTodayKeywords,
  getKeywords,
} from "../services/agents/keyword-analyzer.js";
import { generateKeywordClusters } from "../services/crawler/keyword-cluster.js";
import { getTrendReport, getKeywordTrend } from "../services/agents/keyword-trend.js";
import {
  getDictionaryWords,
  getDictionaryCategories,
  addWord,
  updateWord,
  deleteWord,
  initPresetDictionary,
} from "../services/agents/keyword-dictionary.js";
import { logger } from "../config/logger.js";
import type { PlatformName, CrawlerTrack } from "../services/crawler/types.js";

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

  // ========== 趋势分析路由 ==========

  /**
   * GET /keywords/trends — 获取趋势报告
   */
  app.get("/trends", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit) : 100;

    try {
      const report = await getTrendReport(tenantId, limit);
      return reply.send({ code: "ok", data: report });
    } catch (err) {
      logger.error({ err }, "获取趋势报告失败");
      return reply.status(500).send({ code: "error", message: "获取趋势报告失败" });
    }
  });

  /**
   * GET /keywords/trends/:keyword — 单个关键词趋势详情
   */
  app.get<{ Params: { keyword: string } }>(
    "/trends/:keyword",
    async (request, reply) => {
      const { tenantId } = request.user as { tenantId: string };
      const keyword = decodeURIComponent(request.params.keyword);
      const query = request.query as { days?: string };
      const days = query.days ? parseInt(query.days) : 30;

      try {
        const trend = await getKeywordTrend(tenantId, keyword, days);
        return reply.send({ code: "ok", data: trend });
      } catch (err) {
        logger.error({ err, keyword }, "获取关键词趋势失败");
        return reply.status(500).send({ code: "error", message: "获取趋势失败" });
      }
    }
  );

  // ========== 动态词库路由 ==========

  /**
   * GET /keywords/dictionary — 获取行业词库列表
   */
  app.get("/dictionary", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };
    const query = request.query as {
      level?: string;
      category?: string;
      isActive?: string;
      source?: string;
    };

    const words = await getDictionaryWords(tenantId, {
      level: query.level,
      category: query.category,
      isActive: query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
      source: query.source,
    });

    return reply.send({ code: "ok", data: words });
  });

  /**
   * GET /keywords/dictionary/categories — 获取词库分类
   */
  app.get("/dictionary/categories", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };
    const categories = await getDictionaryCategories(tenantId);
    return reply.send({ code: "ok", data: categories });
  });

  /**
   * POST /keywords/dictionary — 添加行业关键词
   */
  app.post("/dictionary", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };
    const body = request.body as {
      word: string;
      level: "primary" | "secondary" | "context";
      category?: string;
      weight?: number;
    };

    if (!body.word || !body.level) {
      return reply.status(400).send({ code: "error", message: "word 和 level 必填" });
    }

    try {
      const result = await addWord(tenantId, body);
      return reply.send({ code: "ok", data: result });
    } catch (err: any) {
      if (err.code === "23505") {
        return reply.status(409).send({ code: "error", message: "该词已存在" });
      }
      throw err;
    }
  });

  /**
   * POST /keywords/dictionary/init — 初始化预置词库
   */
  app.post("/dictionary/init", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };

    const count = await initPresetDictionary(tenantId);
    return reply.send({ code: "ok", data: { inserted: count } });
  });

  /**
   * PATCH /keywords/dictionary/:id — 更新行业关键词
   */
  app.patch<{ Params: { id: string } }>(
    "/dictionary/:id",
    async (request, reply) => {
      const { tenantId } = request.user as { tenantId: string };
      const body = request.body as {
        category?: string;
        weight?: number;
        isActive?: boolean;
        level?: string;
      };

      await updateWord(tenantId, request.params.id, body);
      return reply.send({ code: "ok" });
    }
  );

  /**
   * DELETE /keywords/dictionary/:id — 删除行业关键词
   */
  app.delete<{ Params: { id: string } }>(
    "/dictionary/:id",
    async (request, reply) => {
      const { tenantId } = request.user as { tenantId: string };
      const success = await deleteWord(tenantId, request.params.id);

      if (!success) {
        return reply.status(400).send({
          code: "error",
          message: "系统预置关键词不能删除，可以通过禁用来隐藏",
        });
      }

      return reply.send({ code: "ok" });
    }
  );

  /**
   * GET /keywords/platforms — 获取已注册爬虫平台
   */
  app.get("/platforms", async (_request, reply) => {
    return reply.send({
      code: "ok",
      data: {
        all: getRegisteredPlatforms(),
        domestic: getPlatformsByTrack("domestic"),
        sci: getPlatformsByTrack("sci"),
      },
    });
  });

  /**
   * POST /keywords/crawl — 手动触发全量抓取（两条线并发）
   */
  app.post("/crawl", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };

    logger.info({ tenantId }, "手动触发全量热点抓取（国内核心+SCI）");
    const startTime = Date.now();

    try {
      const crawlerResults = await crawlAll();

      const report = await analyzeKeywords(crawlerResults, tenantId);

      return reply.send({
        code: "ok",
        data: {
          ...report,
          crawlerSummary: crawlerResults.map((r) => ({
            platform: r.platform,
            track: r.track,
            success: r.success,
            keywordCount: r.keywords.length,
            journalCount: r.journals.length,
            error: r.error,
          })),
          durationMs: Date.now() - startTime,
        },
      });
    } catch (err) {
      logger.error({ err }, "全量抓取失败");
      return reply.status(500).send({ code: "error", message: "抓取失败，请检查日志" });
    }
  });

  /**
   * POST /keywords/crawl/domestic — 只抓国内核心线
   */
  app.post("/crawl/domestic", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };

    logger.info({ tenantId }, "手动触发国内核心线抓取");
    const startTime = Date.now();

    try {
      const crawlerResults = await crawlByTrack("domestic");
      const report = await analyzeKeywords(crawlerResults, tenantId);

      return reply.send({
        code: "ok",
        data: {
          track: "domestic",
          ...report,
          crawlerSummary: crawlerResults.map((r) => ({
            platform: r.platform,
            success: r.success,
            keywordCount: r.keywords.length,
            error: r.error,
          })),
          durationMs: Date.now() - startTime,
        },
      });
    } catch (err) {
      logger.error({ err }, "国内核心线抓取失败");
      return reply.status(500).send({ code: "error", message: "国内核心线抓取失败" });
    }
  });

  /**
   * POST /keywords/crawl/sci — 只抓SCI线
   */
  app.post("/crawl/sci", async (request, reply) => {
    const { tenantId } = request.user as { tenantId: string };

    logger.info({ tenantId }, "手动触发SCI线抓取");
    const startTime = Date.now();

    try {
      const crawlerResults = await crawlByTrack("sci");
      const report = await analyzeKeywords(crawlerResults, tenantId);

      return reply.send({
        code: "ok",
        data: {
          track: "sci",
          ...report,
          crawlerSummary: crawlerResults.map((r) => ({
            platform: r.platform,
            success: r.success,
            journalCount: r.journals.length,
            error: r.error,
          })),
          durationMs: Date.now() - startTime,
        },
      });
    } catch (err) {
      logger.error({ err }, "SCI线抓取失败");
      return reply.status(500).send({ code: "error", message: "SCI线抓取失败" });
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

      // 防止和 /crawl/domestic、/crawl/sci 冲突
      if ((platform as string) === "domestic" || (platform as string) === "sci") {
        return; // 已经被上面的路由处理了
      }

      const registeredPlatforms = getRegisteredPlatforms();
      if (!registeredPlatforms.includes(platform)) {
        return reply.status(400).send({
          code: "error",
          message: `不支持的平台: ${platform}，可用: ${registeredPlatforms.join(", ")}`,
        });
      }

      logger.info({ tenantId, platform }, "手动触发单平台抓取");

      try {
        const result = await crawlPlatform(platform);
        const report = await analyzeKeywords([result], tenantId);

        return reply.send({
          code: "ok",
          data: {
            platform,
            track: result.track,
            success: result.success,
            keywordCount: result.keywords.length,
            journalCount: result.journals.length,
            report,
          },
        });
      } catch (err) {
        logger.error({ err, platform }, "单平台抓取失败");
        return reply.status(500).send({ code: "error", message: `${platform} 抓取失败` });
      }
    }
  );

  /**
   * POST /keywords/clusters — 🔥关键词聚类+标题生成
   *
   * 核心功能：
   *   1. 从百度/OpenAlex/PubMed抓取热门关键词
   *   2. DeepSeek AI 将关键词聚类成2-3个关联组合
   *   3. 为每个组合生成1-2个引流标题
   *
   * Body参数:
   *   track?: "domestic" | "sci" | "all" (默认all)
   *   discipline?: string (可选，指定学科)
   */
  app.post("/clusters", async (request, reply) => {
    const body = request.body as {
      track?: "domestic" | "sci" | "all";
      discipline?: string;
    } || {};

    const track = body.track || "all";
    const discipline = body.discipline;

    logger.info({ track, discipline }, "触发关键词聚类+标题生成");

    try {
      const result = await generateKeywordClusters(track, discipline);

      return reply.send({
        code: "ok",
        data: result,
      });
    } catch (err) {
      logger.error({ err }, "关键词聚类失败");
      return reply.status(500).send({ code: "error", message: "关键词聚类失败" });
    }
  });
}
