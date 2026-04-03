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

/** 内容生成队列 */
export const contentQueue = new Queue("content-generation", {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

/** 爬虫队列 */
export const crawlerQueue = new Queue("crawler", {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

export const contentQueueEvents = new QueueEvents("content-generation", {
  connection: getRedisConnection(),
});

export async function closeQueues(): Promise<void> {
  await contentQueue.close();
  await crawlerQueue.close();
  await contentQueueEvents.close();
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
