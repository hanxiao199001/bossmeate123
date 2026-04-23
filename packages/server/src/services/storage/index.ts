/**
 * 文件存储服务 - 统一抽象接口
 *
 * 第一版支持阿里云 OSS，后续可切换 S3 / 本地磁盘
 * 用于存储视频、图片、音频等媒体文件
 *
 * 文件路径规范: {tenantId}/{category}/{date}/{filename}
 *   例: tenant123/videos/2026-04-14/content456.mp4
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";

/** 存储接口 */
export interface IStorage {
  /** 上传文件，返回公开 URL */
  upload(buffer: Buffer, remotePath: string, contentType?: string): Promise<string>;
  /** 删除文件 */
  delete(remotePath: string): Promise<void>;
  /** 生成带签名的临时 URL */
  getSignedUrl(remotePath: string, ttlSeconds?: number): Promise<string>;
  /** 解析 remotePath 为本地磁盘绝对路径（仅 LocalStorage 可用，OSS 返回 null） */
  resolveLocalPath?(remotePath: string): string;
}

/** 生成标准文件路径 */
export function buildStoragePath(
  tenantId: string,
  category: "videos" | "images" | "audio" | "covers" | "temp",
  filename: string
): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${tenantId}/${category}/${date}/${filename}`;
}

// ============ OSS 实现 ============

class OssStorage implements IStorage {
  private client: any = null;

  private async getClient() {
    if (this.client) return this.client;

    // 动态导入 ali-oss（避免未安装时启动报错）
    try {
      // @ts-ignore - ali-oss is optional, installed at runtime
      const OSS = (await import("ali-oss")).default;
      this.client = new OSS({
        endpoint: env.OSS_ENDPOINT,
        bucket: env.OSS_BUCKET,
        accessKeyId: env.OSS_ACCESS_KEY!,
        accessKeySecret: env.OSS_SECRET_KEY!,
      });
      return this.client;
    } catch (err) {
      throw new Error("ali-oss 未安装，请运行: npm install ali-oss");
    }
  }

  async upload(buffer: Buffer, remotePath: string, contentType?: string): Promise<string> {
    const client = await this.getClient();
    const options: any = {};
    if (contentType) {
      options.headers = { "Content-Type": contentType };
    }

    const result = await client.put(remotePath, buffer, options);
    logger.info({ remotePath, size: buffer.length }, "OSS: 文件已上传");
    return result.url as string;
  }

  async delete(remotePath: string): Promise<void> {
    const client = await this.getClient();
    await client.delete(remotePath);
    logger.info({ remotePath }, "OSS: 文件已删除");
  }

  async getSignedUrl(remotePath: string, ttlSeconds = 3600): Promise<string> {
    const client = await this.getClient();
    return client.signatureUrl(remotePath, { expires: ttlSeconds }) as string;
  }
}

// ============ 本地磁盘实现（开发环境） ============

class LocalStorage implements IStorage {
  private baseDir: string;

  constructor() {
    this.baseDir = join(env.UPLOAD_DIR, "storage");
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async upload(buffer: Buffer, remotePath: string): Promise<string> {
    const fullPath = join(this.baseDir, remotePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const stream = createWriteStream(fullPath);
    stream.write(buffer);
    stream.end();

    await new Promise<void>((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    const url = `/storage/${remotePath}`;
    logger.info({ remotePath, size: buffer.length }, "LocalStorage: 文件已保存");
    return url;
  }

  async delete(remotePath: string): Promise<void> {
    const fullPath = join(this.baseDir, remotePath);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      logger.info({ remotePath }, "LocalStorage: 文件已删除");
    }
  }

  async getSignedUrl(remotePath: string): Promise<string> {
    // 本地存储直接返回路径
    return `/storage/${remotePath}`;
  }

  /** remotePath → 磁盘绝对路径（视频合成 FFmpeg 需要） */
  resolveLocalPath(remotePath: string): string {
    return join(this.baseDir, remotePath);
  }
}

// ============ 导出 ============

/** 根据环境变量自动选择存储实现 */
function createStorage(): IStorage {
  if (env.OSS_ENDPOINT && env.OSS_BUCKET && env.OSS_ACCESS_KEY && env.OSS_SECRET_KEY) {
    logger.info("存储服务: 使用阿里云 OSS");
    return new OssStorage();
  }

  logger.info("存储服务: 使用本地磁盘（开发模式）");
  return new LocalStorage();
}

export const storage = createStorage();
