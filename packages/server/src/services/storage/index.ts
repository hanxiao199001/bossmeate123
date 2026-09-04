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
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join, dirname, relative } from "path";

/** 存储接口 */
export interface IStorage {
  /**
   * 上传文件，返回公开 URL。
   *
   * 🔴 8-26 新增 opts.private: 桶本身是**公共读**(抖音/公众号要能直接拉媒体 URL),
   *   而备份是全库 dump —— 放进同一个桶不加对象级 ACL, 等于把整个客户数据库
   *   挂在一个可枚举的公网地址上。private 走 `x-oss-object-acl: private` 覆盖桶 ACL。
   */
  upload(buffer: Buffer, remotePath: string, contentType?: string, opts?: { private?: boolean }): Promise<string>;
  /** 删除文件 */
  delete(remotePath: string): Promise<void>;
  /** 生成带签名的临时 URL */
  getSignedUrl(remotePath: string, ttlSeconds?: number): Promise<string>;
  /** 解析 remotePath 为本地磁盘绝对路径（仅 LocalStorage 可用，OSS 返回 null） */
  resolveLocalPath?(remotePath: string): string;
  /**
   * 列出某前缀下的对象。8-26 备份保留期清理需要它 —— 不能只按本地记录删,
   * 本地记录丢了(重装/换机)之后 OSS 上的旧备份就永远没人清。
   */
  list(prefix: string, maxKeys?: number): Promise<StorageObject[]>;
  /** 下载对象到内存。8-26 每周恢复演练需要把备份拉回来真恢复一遍 */
  download(remotePath: string): Promise<Buffer>;
  /** 查对象元信息; 不存在返回 null。上传后回查用 —— 只有回查过才算传上去了 */
  head(remotePath: string): Promise<{ size: number } | null>;
}

/** list() 的一行 */
export interface StorageObject {
  path: string;
  size: number;
  lastModified: Date;
}

/**
 * 🔴 超过这个大小走分片上传 (9-04)。
 *
 * ali-oss 单次 `put` 默认 60 秒响应超时。20MB 是个保守阈值:
 * 9-04 实测 43.5MB 的备份**刚好**跑得过去(整个备份任务 77 秒), 69MB 的视频直接超时。
 * 取 20MB 而不是 40MB, 是因为真正的变量是**网速**不是文件大小 ——
 * 阈值该留在"再慢一倍也不会撞线"的位置。
 */
export const MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024;
/** 分片大小。阿里云要求 ≥100KB; 8MB 是官方示例的常用值 */
export const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * 最近一次上传耗时(秒)。备份任务读它落进 ops_backups.upload_seconds ——
 * 让"贴着 60 秒线"这件事能被**提前看见**, 而不是等 backup_failed 才知道。
 */
let lastUploadSeconds = 0;
export function getLastUploadSeconds(): number { return lastUploadSeconds; }

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

/**
 * ## 关于 timeout（9-04）
 *
 * ali-oss 默认**每次 HTTP 响应** 60 秒超时，这才是真正卡住备份的那条线。
 *
 * 病历：9-01 备份成功（43.5MB / 77 秒），9-03 起连续失败 `ResponseTimeoutError`，
 * 生产**连续两天没有备份**。9-04 先加了 ">20MB 走分片" —— **没解决**：
 * 分片只是把一个大请求拆成多个，每一片仍受同一个 60 秒约束，
 * 实测报 `Failed to upload some parts ... part_num: 2`。
 *
 * ▎ 判断失误的由来：9-04 存档那条 69MB 视频时用的是
 * ▎ `new OSS({..., timeout: 600000 })` —— 是**这个参数**让它成功的，
 * ▎ 而当时只把 multipart 搬了过来、把 timeout 漏了，
 * ▎ 然后把"分片能解决"当成了已验证的结论。
 *
 * 600000 = 10 分钟。按 9-01 实测 565KB/s 够传约 340MB；
 * 按今天的坏情况（<133KB/s）也够 78MB。
 *
 * ⚠️ 速度本身是另一个问题，**不要靠调大这个数去治**：
 * 9-01 是 565KB/s，9-04 是 <133KB/s，慢了 4 倍以上。
 * `upload_seconds` 已落台账，连看 3 天；若持续 >300 秒，
 * 那是**带宽问题**（轻量应用服务器有上行带宽限制），到时另议。
 *
 * ⚠️ 注释写在类上方而不是初始化里：`oss-url-https.test.ts` 的守卫只取
 * `new OSS(` 之后 900 字符来找 `secure: true`，长注释会把它挤出扫描窗口。
 * （9-04 CI 抓出来的 —— 守卫本身没错，是注释放错了位置。）
 */
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
        // 🔴 9-04: 见本类上方「关于 timeout」—— 分片不解决超时, 这一行才是。
        timeout: 600_000,
      });
      return this.client;
    } catch (err) {
      throw new Error("ali-oss 未安装，请运行: npm install ali-oss");
    }
  }

  async upload(buffer: Buffer, remotePath: string, contentType?: string, opts?: { private?: boolean }): Promise<string> {
    const client = await this.getClient();
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    // 对象级 ACL 覆盖桶级 —— 桶是公共读, 备份必须私有。见 IStorage.upload 的注释。
    if (opts?.private) headers["x-oss-object-acl"] = "private";
    const options: any = Object.keys(headers).length ? { headers } : {};

    const startedAt = Date.now();
    /**
     * 🔴 9-04: 超过 MULTIPART_THRESHOLD_BYTES 走分片。
     *
     * 病历: ali-oss 的单次 put 有 **60 秒响应超时**(默认)。9-04 存档那条 69MB 的
     * 数字人成片时直接 `ResponseTimeoutError`, 而当时**每日备份的 43.5MB 刚好跑得过去** ——
     * 贴着这条线。库再长一点、或网络慢一点, 备份就会稳定失败。
     *
     * 失败形态是 backup_failed(会正确告警), 但那时**已经没有备份了** ——
     * 告警对了不等于损失没发生。所以在撞线之前就把它拆掉, 而不是等它响。
     */
    const useMultipart = buffer.length > MULTIPART_THRESHOLD_BYTES;
    let url: string;
    if (useMultipart) {
      const r = await client.multipartUpload(remotePath, buffer, {
        partSize: MULTIPART_PART_SIZE_BYTES,
        ...options,
      });
      // multipartUpload 的返回形状与 put 不同: url 在 res.requestUrls[0](带 uploadId 查询串),
      //   不能直接当公开地址用。自己按 endpoint+bucket 拼一个干净的。
      url = (r as { res?: { requestUrls?: string[] } })?.res?.requestUrls?.[0]?.split("?")[0]
        ?? `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/${remotePath}`;
    } else {
      const result = await client.put(remotePath, buffer, options);
      url = result.url as string;
    }
    const uploadSeconds = (Date.now() - startedAt) / 1000;
    logger.info(
      { remotePath, size: buffer.length, uploadSeconds, multipart: useMultipart },
      "OSS: 文件已上传",
    );
    lastUploadSeconds = uploadSeconds;
    return url;
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

  /**
   * 8-26: 列出前缀下的对象(自动翻页, ali-oss 单页上限 1000)。
   * maxKeys 是**总量**上限, 不是单页 —— 备份前缀下条目不多, 但别让分页 bug 变成"只清了第一页"。
   */
  async list(prefix: string, maxKeys = 1000): Promise<StorageObject[]> {
    const client = await this.getClient();
    const out: StorageObject[] = [];
    let marker: string | undefined;
    do {
      const page = await client.list({ prefix, "max-keys": Math.min(1000, maxKeys - out.length), marker }, {});
      for (const o of (page.objects ?? []) as Array<{ name: string; size: number; lastModified: string }>) {
        out.push({ path: o.name, size: Number(o.size), lastModified: new Date(o.lastModified) });
      }
      marker = page.isTruncated ? (page.nextMarker as string) : undefined;
    } while (marker && out.length < maxKeys);
    return out;
  }

  async download(remotePath: string): Promise<Buffer> {
    const client = await this.getClient();
    const res = await client.get(remotePath);
    return res.content as Buffer;
  }

  async head(remotePath: string): Promise<{ size: number } | null> {
    const client = await this.getClient();
    try {
      const res = await client.head(remotePath);
      // ali-oss 把 Content-Length 放在 res.res.headers 里
      const len = Number(res?.res?.headers?.["content-length"] ?? NaN);
      return Number.isFinite(len) ? { size: len } : null;
    } catch (err) {
      // 404 = 对象不存在(调用方据此判定"没传上去"); 其余错误照旧抛, 别把网络故障洗成"文件不存在"
      if ((err as { status?: number })?.status === 404) return null;
      throw err;
    }
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

  async upload(buffer: Buffer, remotePath: string, _contentType?: string, _opts?: { private?: boolean }): Promise<string> {
    // 本地实现没有 ACL 概念; 参数保留只为签名一致(备份路径在生产恒走 OSS, 见 backup.ts 的守卫)
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

  async list(prefix: string, maxKeys = 1000): Promise<StorageObject[]> {
    const root = join(this.baseDir, prefix);
    if (!existsSync(root)) return [];
    const out: StorageObject[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= maxKeys) return;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        const st = statSync(full);
        out.push({ path: relative(this.baseDir, full), size: st.size, lastModified: st.mtime });
      }
    };
    walk(root);
    return out;
  }

  async download(remotePath: string): Promise<Buffer> {
    return readFileSync(join(this.baseDir, remotePath));
  }

  async head(remotePath: string): Promise<{ size: number } | null> {
    const full = join(this.baseDir, remotePath);
    return existsSync(full) ? { size: statSync(full).size } : null;
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
