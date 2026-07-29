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
        // 7-30 secure: ali-oss 默认吐 http:// —— put().url 与 signatureUrl() 都是。
        //   后果两类:
        //     ① 管理页是 https, 浏览器按混合内容(mixed content)直接拦掉 http 图片 → 缩略图空白,
        //        看着像"没存进去", 实际存了(7-29 背景图库实测就是这个现象)。
        //     ② 签名 URL 同样是 http, DVH 音频/字幕靠它取件。阿里云服务端拉取现在不挑协议,
        //        但哪天收紧到只收 https, 整条数字人链路会一起断 —— 那时候排查成本远高于现在加这一行。
        //   为什么在这里而不是在消费方补: URL 是 storage 层产出的, 所有用它的地方(封面/音频/
        //   视频/混剪素材/背景图, 23 个调用点)都有这个问题。在背景图那边补一次, 其余照旧是 http,
        //   就变成"同一个问题在 N 处各修各的"。用官方 secure 选项也好过字符串替换 http→https:
        //   后者遇到自定义域/内网端点会改错。
        //   实测(生产桶 bossmate-media): 开 secure 后 put().url 与 signatureUrl() 都转 https,
        //   且签名 URL 真下载得到(GET 200), 不是只换了前缀。
        secure: true,
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

// 懒实例化(7-06): 原 `export const storage = createStorage()` 在 import 时急切实例化 —
// createStorage 读 env(OSS_*/UPLOAD_DIR) + LocalStorage 构造器 mkdirSync = import 副作用 + env 依赖,
// 任一 env 不完整(如测试 vi.mock 漏 UPLOAD_DIR)就在 import 时硬崩, 拖垮整套测试 load。
// 改懒代理: 保持 `storage` 导出形状与 IStorage 类型不变(全仓 storage.xxx 调用点零改动), 首次访问方法时才 createStorage。
// ⚠️ 不加 ?? 静默兜底: 生产 env 真缺失时, 首次使用清晰 fail-fast(总比悄悄把文件写进错目录好); mkdir 副作用随之延到首次使用。
let _storageInstance: IStorage | null = null;
export function getStorage(): IStorage {
  if (!_storageInstance) _storageInstance = createStorage();
  return _storageInstance;
}
export const storage: IStorage = new Proxy({} as IStorage, {
  get(_t, prop) {
    const inst = getStorage();
    const value = Reflect.get(inst, prop, inst);
    return typeof value === "function" ? value.bind(inst) : value;
  },
});
