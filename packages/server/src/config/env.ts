import { config } from "dotenv";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";

// 从当前目录向上查找 .env 文件（支持 monorepo）
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = resolve(dir, ".env");
    if (existsSync(envPath)) return envPath;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

config({ path: findEnvFile() });

const envSchema = z.object({
  // 服务
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default("/api/v1"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // 数据库
  DATABASE_URL: z.string().min(1, "DATABASE_URL 必须配置"),
  DATABASE_POOL_SIZE: z.coerce.number().default(10),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // JWT
  JWT_SECRET: z.string().min(8, "JWT_SECRET 至少8位"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // AI - 贵模型
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // AI - 便宜模型
  DEEPSEEK_API_KEY: z.string().optional(),
  QWEN_API_KEY: z.string().optional(),

  // 模型路由
  DEFAULT_EXPENSIVE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  DEFAULT_CHEAP_MODEL: z.string().default("deepseek-chat"),
  MODEL_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5),

  // 知识库
  LANCEDB_PATH: z.string().default("./data/lancedb"),

  // 文件
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_FILE_SIZE: z.string().default("50mb"),

  // 日志
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOG_DIR: z.string().default("./logs"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ 环境变量校验失败:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const data = result.data;

  // 检查是否至少有一个可用的 Embedding API Key
  const hasEmbeddingKey =
    (data.QWEN_API_KEY && data.QWEN_API_KEY !== "your-qwen-api-key") ||
    (data.DEEPSEEK_API_KEY && data.DEEPSEEK_API_KEY !== "your-deepseek-api-key") ||
    data.OPENAI_API_KEY;

  if (!hasEmbeddingKey) {
    if (data.NODE_ENV === "production") {
      console.error(
        "❌ 生产环境必须配置至少一个 Embedding API Key (QWEN_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY)"
      );
      process.exit(1);
    } else {
      console.warn(
        "⚠️ 未配置 Embedding API Key，知识库功能将使用本地 hash 向量（仅开发环境）"
      );
    }
  }

  return data;
}

export const env = loadEnv();
