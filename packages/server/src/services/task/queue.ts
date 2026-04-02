import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env.js";

type RedisInstance = InstanceType<typeof IORedis.default>;
let connection: RedisInstance | null = null;

export function getRedisConnection(): RedisInstance {
  if (!connection) {
    connection = new IORedis.default(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    connection.on("error", (err: Error) => {
      console.error("Redis connection error:", err.message);
    });
    connection.on("connect", () => {
      console.log("Redis connected for task queue");
    });
  }
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
