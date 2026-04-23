/**
 * 视频合成 Worker
 *
 * BullMQ Worker，消费 "video-generation" 队列。
 * 每个 job 将用户上传的图片序列合成为宣传短视频。
 *
 * 约束：
 *  - concurrency = env.VIDEO_WORKER_CONCURRENCY (默认 1，CPU-bound)
 *  - lockDuration = 10 分钟（长任务防 stalled）
 *  - 每 tenant 并发 ≤ env.VIDEO_TENANT_MAX_CONCURRENT (默认 2)
 */

import { Worker } from "bullmq";
import { getRedisConnection } from "./queue.js";
import { produceFromImages, type ImageToVideoInput, type ImageToVideoResult } from "../video/index.js";
import { db } from "../../models/db.js";
import { contents } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export interface VideoJobData {
  tenantId: string;
  userId: string;
  title: string;
  input: ImageToVideoInput;
}

export interface VideoJobResult extends ImageToVideoResult {
  contentId?: string;
}

export function startVideoWorker(): Worker<VideoJobData, VideoJobResult> {
  const worker = new Worker<VideoJobData, VideoJobResult>(
    "video-generation",
    async (job) => {
      const { tenantId, userId, title, input } = job.data;
      logger.info({ jobId: job.id, tenantId, title, images: input.images.length }, "视频合成任务开始");

      await job.updateProgress(5);

      // 调用核心合成
      const result = await produceFromImages(input, async (percent: number) => {
        await job.updateProgress(percent);
      });

      await job.updateProgress(95);

      // 写入 contents 表
      let contentId: string | undefined;
      try {
        const [row] = await db
          .insert(contents)
          .values({
            tenantId,
            userId,
            type: "video",
            title,
            body: result.url,
            status: "published",
            metadata: {
              videoUrl: result.url,
              coverUrl: result.coverUrl,
              remotePath: result.remotePath,
              coverRemotePath: result.coverRemotePath,
              durationMs: result.durationMs,
              sizeBytes: result.sizeBytes,
              resolution: result.resolution,
              scenesCount: result.scenesCount,
            },
          })
          .returning({ id: contents.id });
        contentId = row.id;
      } catch (err) {
        logger.error({ err }, "视频记录写入 contents 表失败");
      }

      await job.updateProgress(100);
      logger.info({
        jobId: job.id,
        contentId,
        durationMs: result.durationMs,
        sizeBytes: result.sizeBytes,
      }, "视频合成任务完成");

      return { ...result, contentId };
    },
    {
      connection: getRedisConnection(),
      concurrency: env.VIDEO_WORKER_CONCURRENCY,
      lockDuration: 10 * 60 * 1000, // 10 分钟
      stalledInterval: 5 * 60 * 1000,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "视频合成任务失败");
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "视频合成任务已完成");
  });

  logger.info({ concurrency: env.VIDEO_WORKER_CONCURRENCY }, "视频合成 Worker 已启动");
  return worker;
}
