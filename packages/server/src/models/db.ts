import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_SIZE,
});

pool.on("error", (err) => {
  logger.error(err, "PostgreSQL 连接池错误（连接池将自动重试）");
});

pool.on("connect", () => {
  logger.debug("PostgreSQL 新连接建立");
});

export const db = drizzle(pool, { schema });

/**
 * 测试数据库连接
 */
export async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query("SELECT NOW()");
    client.release();
    logger.info("✅ PostgreSQL 连接成功");
    return true;
  } catch (err) {
    logger.error(err, "❌ PostgreSQL 连接失败");
    return false;
  }
}

/**
 * 关闭连接池
 */
export async function closePool() {
  await pool.end();
  logger.info("PostgreSQL 连接池已关闭");
}
