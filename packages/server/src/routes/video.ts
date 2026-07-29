/**
 * 视频 API 路由
 *
 * POST /video/upload-images   上传图片素材
 * POST /video/dvh-background  上传数字人视频背景图(9:16/16:9 强校验 + 内容审核, 返回公网 URL)
 * POST /video/compose         创建视频合成任务
 * GET  /video/status/:jobId   查询合成进度
 * GET  /video/list            获取视频列表
 * GET  /video/bgm-list        获取预置 BGM 列表
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { storage } from "../services/storage/index.js";
import { videoQueue } from "../services/task/queue.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import type { VideoJobData } from "../services/task/video-worker.js";

const MIME_WHITELIST = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const composeSchema = z.object({
  title: z.string().min(1).max(100),
  images: z.array(z.object({
    remotePath: z.string().min(1),
    durationMs: z.number().int().min(2000).max(15000).optional(),
    title: z.string().max(50).optional(),
    subtitle: z.string().max(100).optional(),
    animation: z.enum(["kenburns_in", "kenburns_out", "pan_left", "pan_right", "static"]).optional(),
  })).min(1).max(15),
  bgmId: z.enum(["gentle", "business", "upbeat"]).optional(),
  resolution: z.enum(["1080x1920", "1920x1080"]).optional(),
  transition: z.enum(["fade", "dissolve", "none"]).optional(),
});

export async function videoRoutes(app: FastifyInstance) {

  /**
   * GET /video/bgm-list — 预置 BGM 列表
   */
  app.get("/bgm-list", async () => {
    return {
      code: "OK",
      data: [
        { id: "gentle", name: "轻音乐", description: "舒缓轻音乐，适合产品展示" },
        { id: "business", name: "商务", description: "专业商务风，适合企业宣传" },
        { id: "upbeat", name: "节奏感", description: "轻快节奏，适合促销活动" },
      ],
    };
  });

  /**
   * POST /video/upload-images — 上传图片素材
   */
  app.post("/upload-images", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const parts = request.parts();
      const uploaded: Array<{ remotePath: string; url: string; width: number; height: number; sizeBytes: number }> = [];

      for await (const part of parts) {
        if (part.type !== "file") continue;

        // MIME 白名单校验
        if (!MIME_WHITELIST.has(part.mimetype)) {
          return reply.code(400).send({ code: "INVALID_TYPE", message: `不支持的图片格式: ${part.mimetype}` });
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of part.file) {
          totalSize += chunk.length;
          if (totalSize > MAX_FILE_SIZE) {
            return reply.code(400).send({ code: "FILE_TOO_LARGE", message: `图片超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制` });
          }
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);

        // sharp 校验 + 读取尺寸
        let meta: sharp.Metadata;
        try {
          meta = await sharp(buf).metadata();
        } catch {
          return reply.code(400).send({ code: "INVALID_IMAGE", message: "无法识别的图片文件" });
        }

        // 上传到 storage
        const ext = part.mimetype === "image/png" ? "png" : part.mimetype === "image/webp" ? "webp" : "jpg";
        const remotePath = `${tenantId}/video-images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const url = await storage.upload(buf, remotePath, part.mimetype);

        uploaded.push({
          remotePath,
          // 7-29: storage.upload 的返回值(OSS 公共读裸 URL / 本地相对路径)原来被丢掉了。
          //   纯增量字段, 老调用方(VideoCreationPage → /video/compose 用 remotePath)不受影响。
          url,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          sizeBytes: buf.length,
        });
      }

      if (uploaded.length === 0) {
        return reply.code(400).send({ code: "NO_IMAGES", message: "请至少上传一张图片" });
      }

      return { code: "OK", data: { images: uploaded } };
    } catch (err) {
      logger.error({ err }, "图片上传失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "图片上传失败" });
    }
  });

  /**
   * POST /video/dvh-background — 7-29 运营为「本次数字人生成」上传本地背景图。
   *
   * 与 /upload-images 的区别(所以单开一个而不是加参数):
   *   - 强制 9:16 / 16:9 宽高比 + 短边 ≥720 (DVH submit 即扣费, 比例错了钱就白花)
   *   - 强制图片内容审核(背景图会进公开视频)
   *   - 返回**公网 URL** 而不是 remotePath —— 阿里云要自己去拉这张图
   * 上传的图**不进系统图库**(那是管理员的 /admin/dvh-backgrounds), 只供本次生成使用。
   */
  app.post("/dvh-background", async (request, reply) => {
    const { processBackgroundUpload, BackgroundUploadError } =
      await import("../services/digital-human/background-library.js");
    try {
      const tenantId = request.tenantId;
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file) {
          total += (chunk as Buffer).length;
          if (total > 10 * 1024 * 1024) {
            return reply.code(400).send({ code: "FILE_TOO_LARGE", message: "背景图超过 10MB 限制" });
          }
          chunks.push(chunk as Buffer);
        }
        const r = await processBackgroundUpload({
          buffer: Buffer.concat(chunks), mimetype: part.mimetype, tenantId, scope: "tenant",
        });
        // 只收第一张 — 一次生成只有一个背景
        return {
          code: "OK",
          data: { url: r.url, width: r.width, height: r.height, orientation: r.orientation, remotePath: r.remotePath },
        };
      }
      return reply.code(400).send({ code: "NO_IMAGES", message: "请选择一张背景图" });
    } catch (err) {
      if (err instanceof BackgroundUploadError) {
        return reply.code(400).send({ code: err.code, message: err.message });
      }
      logger.error({ err }, "DVH 背景图上传失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "背景图上传失败" });
    }
  });

  /**
   * POST /video/compose — 创建视频合成任务
   */
  app.post("/compose", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const userId = request.user.userId;
      const body = composeSchema.parse(request.body);

      // 租户隔离：remotePath 必须以 tenantId/ 开头
      for (const img of body.images) {
        if (!img.remotePath.startsWith(`${tenantId}/`)) {
          return reply.code(403).send({ code: "FORBIDDEN", message: "不允许访问其他租户的资源" });
        }
      }

      // 总时长校验
      const totalSec = body.images.reduce((s, img) => s + (img.durationMs ?? 4000) / 1000, 0);
      if (totalSec > env.VIDEO_MAX_DURATION_SEC) {
        return reply.code(400).send({ code: "TOO_LONG", message: `视频总时长不能超过 ${env.VIDEO_MAX_DURATION_SEC} 秒` });
      }

      // 每 tenant 并发限制
      const activeJobs = await videoQueue.getJobs(["active", "waiting"]);
      const tenantJobCount = activeJobs.filter((j: any) => j.data?.tenantId === tenantId).length;
      if (tenantJobCount >= env.VIDEO_TENANT_MAX_CONCURRENT) {
        return reply.code(429).send({
          code: "TOO_MANY_JOBS",
          message: `同时最多 ${env.VIDEO_TENANT_MAX_CONCURRENT} 个视频在合成中，请等待完成后再试`,
        });
      }

      // P1 图片内容审核: 视频合成前审图片(阿里云内容安全 baselineCheck)。remotePath→签名URL(公网可达)传审核。
      //   block→拒绝合成(记原因返回前端); review→放行(仅记 warn); 审核挂掉走兜底(strict on=拦/off=放行)。
      const { moderateImages, IMAGE_MODERATION_ENABLED } = await import("../services/compliance/image-moderation.js");
      if (IMAGE_MODERATION_ENABLED) {
        try {
          const urls = await Promise.all(body.images.map((i) => storage.getSignedUrl(i.remotePath, 900)));
          const mod = await moderateImages(urls.filter((u) => /^https?:\/\//i.test(u)));
          if (mod.blocked) {
            const bad = mod.results.filter((r) => r.suggestion === "block").map((r) => r.label);
            logger.warn({ tenantId, bad, fallback: mod.fallback }, "图片内容审核: 拦截视频合成");
            return reply.code(400).send({
              code: "IMAGE_MODERATION_BLOCKED",
              message: `图片内容审核未通过, 已拦截合成${bad.length ? `: ${[...new Set(bad)].join("、")}` : ""}`,
            });
          }
          const reviews = mod.results.filter((r) => r.suggestion === "review");
          if (reviews.length > 0) logger.warn({ tenantId, reviews }, "图片内容审核: 可疑放行(review)");
        } catch (err) {
          // moderateImages 自身已兜底, 这里只兜签名URL等前置异常, 不阻塞合成
          logger.warn({ err, tenantId }, "图片内容审核前置异常, 跳过审核放行");
        }
      }

      const jobData: VideoJobData = {
        tenantId,
        userId,
        title: body.title,
        input: {
          tenantId,
          title: body.title,
          images: body.images,
          bgmId: body.bgmId,
          resolution: body.resolution,
          transition: body.transition,
        },
      };

      const job = await videoQueue.add("image-to-video", jobData, {
        jobId: `video-${tenantId}-${Date.now()}`,
      });

      logger.info({ jobId: job.id, tenantId, images: body.images.length }, "视频合成任务已入队");

      return reply.code(201).send({
        code: "OK",
        data: {
          jobId: job.id,
          estimatedDurationSec: Math.round(totalSec),
        },
      });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return reply.code(400).send({ code: "VALIDATION_ERROR", message: err.errors?.[0]?.message || "参数校验失败" });
      }
      logger.error({ err }, "创建视频合成任务失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "创建任务失败" });
    }
  });

  /**
   * GET /video/status/:jobId — 查询合成进度
   */
  app.get("/status/:jobId", async (request, reply) => {
    const tenantId = request.tenantId;
    const { jobId } = request.params as { jobId: string };

    const job = await videoQueue.getJob(jobId);
    if (!job) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    }

    // 租户隔离
    if (job.data.tenantId !== tenantId) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    }

    const state = await job.getState();
    const progress = typeof job.progress === "number" ? job.progress : 0;

    return {
      code: "OK",
      data: {
        jobId: job.id,
        status: state,
        progress,
        result: state === "completed" ? job.returnvalue : undefined,
        error: state === "failed" ? job.failedReason : undefined,
      },
    };
  });

  /**
   * GET /video/list — 获取视频列表
   */
  app.get("/list", async (request) => {
    const tenantId = request.tenantId;
    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, parseInt(query.page || "1"));
    const pageSize = Math.min(50, parseInt(query.pageSize || "20"));

    const rows = await db
      .select()
      .from(contents)
      .where(and(eq(contents.tenantId, tenantId), eq(contents.type, "video")))
      .orderBy(desc(contents.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      code: "OK",
      data: {
        items: rows.map(r => ({
          id: r.id,
          title: r.title,
          videoUrl: r.body,
          metadata: r.metadata,
          status: r.status,
          createdAt: r.createdAt,
        })),
        page,
        pageSize,
      },
    };
  });
}
