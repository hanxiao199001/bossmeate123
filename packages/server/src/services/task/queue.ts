import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

type RedisInstance = InstanceType<typeof IORedis.default>;
let connection: RedisInstance | null = null;
let connecting = false;

export function getRedisConnection(): RedisInstance {
  if (connection) return connection;
  if (connecting) {
    // 防止并发初始化，复用正在创建的连接
    connection = new IORedis.default(env.REDIS_URL, { maxRetriesPerRequest: null });
    return connection;
  }
  connecting = true;
  connection = new IORedis.default(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  connection.on("error", (err: Error) => {
    logger.error({ err: err.message }, "Redis 连接错误");
  });
  connection.on("connect", () => {
    logger.info("Redis 连接成功");
  });
  return connection;
}

// 7-18 架构审计 A2: 队列惰性化 — 原本模块顶层 `new Queue()` 在 import 时就调 getRedisConnection() 开 Redis 连接,
//   导致任何 import 本模块的脚本/测试(如万方脚本 import orchestrator 链)一加载就连 Redis, 甚至卡死。
//   改用 Proxy 惰性: 首次访问队列成员时才真正 new Queue(), 导出名与所有调用点不变(x.add/x.close 照旧)。
//   仅注册真正入队/消费的进程才连 Redis, 与 storage/index.ts 的惰性 Proxy 同一模式。
type QueueLike = Queue | QueueEvents;
const _instances = new Map<string, QueueLike>();
export function lazyQueue<T extends QueueLike>(key: string, factory: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      let inst = _instances.get(key);
      if (!inst) { inst = factory(); _instances.set(key, inst); }
      const value = Reflect.get(inst, prop, inst);
      return typeof value === "function" ? value.bind(inst) : value;
    },
  }) as T;
}

/** 内容生成队列 */
export const contentQueue = lazyQueue("contentQueue", () => new Queue("content-generation", {
  connection: getRedisConnection(),
  defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 50 },
}));

/** 爬虫队列 */
export const crawlerQueue = lazyQueue("crawlerQueue", () => new Queue("crawler", {
  connection: getRedisConnection(),
  defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 10000 }, removeOnComplete: 50, removeOnFail: 50 },
}));

export const contentQueueEvents = lazyQueue("contentQueueEvents", () => new QueueEvents("content-generation", { connection: getRedisConnection() }));

/** 视频合成队列 */
export const videoQueue = lazyQueue("videoQueue", () => new Queue("video-generation", {
  connection: getRedisConnection(),
  defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 10000 }, removeOnComplete: 50, removeOnFail: 30 },
}));

export const videoQueueEvents = lazyQueue("videoQueueEvents", () => new QueueEvents("video-generation", { connection: getRedisConnection() }));

/** 期刊 enrichment 队列（B.2.1.A） */
export const journalEnrichQueue = lazyQueue("journalEnrichQueue", () => new Queue("journal-enrich", {
  connection: getRedisConnection(),
  defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 15000 }, removeOnComplete: 50, removeOnFail: 50 },
}));

export const journalEnrichQueueEvents = lazyQueue("journalEnrichQueueEvents", () => new QueueEvents("journal-enrich", { connection: getRedisConnection() }));

export async function closeQueues(): Promise<void> {
  // 只关真正实例化过的(没被访问过的队列不会建连接, 无需关)
  for (const inst of _instances.values()) await inst.close().catch(() => undefined);
  _instances.clear();
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
