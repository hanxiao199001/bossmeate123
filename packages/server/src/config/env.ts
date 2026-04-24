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

  // 凭证加密密钥
  CREDENTIALS_KEY: z.string().optional(),

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
  AI_FALLBACK_STRATEGY: z.enum(["serial", "race"]).default("serial"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().default(60000),
  AI_ARTICLE_TIMEOUT_MS: z.coerce.number().default(120000),

  // 模型直映射（T2）— TaskType → 具体模型名
  DEEPSEEK_MODEL_CHAT: z.string().default("deepseek-chat"),
  DEEPSEEK_MODEL_REASONER: z.string().default("deepseek-reasoner"),
  QWEN_MODEL_PLUS: z.string().default("qwen-plus"),
  QWEN_MODEL_MAX: z.string().default("qwen-max"),

  // 知识库
  LANCEDB_PATH: z.string().default("./data/lancedb"),

  // 文件
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_FILE_SIZE: z.string().default("50mb"),

  // Springer Nature API
  SPRINGER_API_KEY: z.string().optional(),
  SPRINGER_PROXY: z.string().optional(), // 代理地址（如 http://127.0.0.1:7890）

  // CORS
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),

  // 日志
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOG_DIR: z.string().default("./logs"),

  // === V3 新增 ===

  // CEO Agent 开关（false=走旧 Orchestrator，true=走新 CEO Agent + EventBus）
  USE_CEO_AGENT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // 对象存储 (OSS)
  OSS_ENDPOINT: z.string().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_ACCESS_KEY: z.string().optional(),
  OSS_SECRET_KEY: z.string().optional(),

  // TTS 配音
  TTS_PROVIDER: z.enum(["aliyun", "azure"]).default("aliyun"),
  TTS_API_KEY: z.string().optional(),
  TTS_VOICE_ID: z.string().default("xiaoyun"),
  // 阿里云 NLS 凭证（AccessKey 动态换 Token）
  ALIYUN_AK_ID: z.string().optional(),
  ALIYUN_AK_SECRET: z.string().optional(),
  ALIYUN_NLS_APPKEY: z.string().optional(),

  // 视频
  VIDEO_RESOLUTION: z.string().default("1080x1920"),
  BGM_DEFAULT_PATH: z.string().default("data/bgm/default.mp3"),

  // 素材图库
  PEXELS_API_KEY: z.string().optional(),

  // 企业微信
  WECHAT_WORK_CORP_ID: z.string().optional(),
  WECHAT_WORK_SECRET: z.string().optional(),
  WECHAT_WORK_TOKEN: z.string().optional(),
  WECHAT_WORK_AES_KEY: z.string().optional(),

  // 质量检查
  QUALITY_MIN_SCORE: z.coerce.number().default(70),

  // 视频合成
  VIDEO_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  VIDEO_MAX_IMAGES: z.coerce.number().int().default(15),
  VIDEO_MAX_DURATION_SEC: z.coerce.number().int().default(120),
  VIDEO_TENANT_MAX_CONCURRENT: z.coerce.number().int().default(2),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  VIDEO_FONT_PATH: z.string().optional(),

  // 销售自动跟进
  SALES_AUTO_FOLLOWUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // AI 销售对话模块总开关（腾讯云上线时先关闭）
  SALES_AGENT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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

  // JWT_SECRET 强度校验
  if (data.NODE_ENV === "production") {
    if (data.JWT_SECRET.length < 32) {
      console.error(
        "❌ 生产环境 JWT_SECRET 必须至少 32 位，当前长度: " + data.JWT_SECRET.length
      );
      process.exit(1);
    }
  } else if (data.JWT_SECRET.length < 32) {
    console.warn(
      "⚠️ 开发环境: JWT_SECRET 建议至少 32 位，当前长度: " + data.JWT_SECRET.length
    );
  }

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

  // T2：Anthropic / OpenAI 路径已下线；若仍有 Key 配置打 warn 提醒清理
  if (data.ANTHROPIC_API_KEY) {
    console.warn(
      "⚠️ 检测到 ANTHROPIC_API_KEY，但 Claude 路径已下线（T2），该 Key 不会被使用，建议从 .env 移除"
    );
  }
  if (data.OPENAI_API_KEY) {
    console.warn(
      "⚠️ 检测到 OPENAI_API_KEY，但 OpenAI 路径已下线（T2），该 Key 不会被使用，建议从 .env 移除"
    );
  }

  // 检查关键凭证变量的有效性
  if (data.NODE_ENV === "production") {
    if (!data.DATABASE_URL || data.DATABASE_URL === "postgresql://localhost") {
      console.error("❌ 生产环境必须配置有效的 DATABASE_URL");
      process.exit(1);
    }
  }

  return data;
}

export const env = loadEnv();
