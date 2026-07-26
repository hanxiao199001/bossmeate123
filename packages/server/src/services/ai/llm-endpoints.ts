/**
 * LLM 接入点(baseURL + apiKey)单一真相源 —— 7-26 "同一个 deepseek 模型, 换个账户跑"。
 *
 * 背景: DeepSeek 官方账户余额见底(¥17≈3 天), 阿里云百炼上有同名的 deepseek-v4-pro,
 *   **官方公告与官网同价**, 老板刚给百炼充了钱。所以只要把 baseURL 指向百炼即可继续跑,
 *   模型不变 = 生成质量零变化。
 *
 * 铁律(本文件存在的唯一理由): **baseURL 与 apiKey 必须成对切换**。
 *   baseURL 指百炼却还带 DeepSeek 的 key = 每一次调用 401。而 401 属客户端错误,
 *   不触发 qwen 兜底 —— 结果就是 7-24 那次事故的重演: 整条生成链路静默产废稿
 *   ("抱歉，AI暂时无法响应")。所以这里只暴露**一个开关** DEEPSEEK_VIA,
 *   由它同时决定 baseURL 和 key 的来源, 配错的可能性从"两个变量要对上"降到 0。
 *   逃生口 DEEPSEEK_BASE_URL 仍在(万一百炼换域名/走专线), 但一旦它与 key 来源不配套,
 *   启动期自检会拦下并打印可读报错(生产直接 exit, 别让它带病跑)。
 *
 * 本文件的核心是**纯函数**(resolveLlmEndpoints / checkLlmEndpointConfig, 入参是配置对象),
 * 便于单测覆盖各种配错组合; 读 env 的只是最外面那层薄包装。
 */

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export type LlmProviderName = "deepseek" | "qwen";

/** 真实扣谁的钱 —— 记账要用(见 billing/llm-cost.ts) */
export type BillingAccount = "deepseek" | "bailian";

/** DeepSeek 官方 OpenAI 兼容端点(现状默认, 行为不变) */
export const DEEPSEEK_OFFICIAL_BASE_URL = "https://api.deepseek.com/v1";

/**
 * 阿里云百炼(Model Studio) OpenAI 兼容端点 —— 北京地域。
 * 注意与 DASHSCOPE_BASE_URL(= https://dashscope.aliyuncs.com/api/v1, 百炼**原生**接口,
 * 给 qwen-tts / 声音克隆用)区分开: 那条路径不吃 /chat/completions, 填错必 404。
 * 海外地域是 https://dashscope-us.aliyuncs.com/compatible-mode/v1(我们不用)。
 */
export const BAILIAN_OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** .env.example 里的占位值 —— 等同于"没配"(与 config/env.ts、embedding-service 同口径) */
const PLACEHOLDER_KEYS = new Set(["your-deepseek-api-key", "your-qwen-api-key", "your-api-key"]);

export interface LlmEndpoint {
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string;
  /** key 取自哪个 env 变量 —— 报错时要说清"你拿谁的 key 打谁的门" */
  keySource: "DEEPSEEK_API_KEY" | "QWEN_API_KEY";
  /** 真实扣费账户 */
  billingAccount: BillingAccount;
}

/** 纯函数入参: 与 env 解耦, 单测可任意构造 */
export interface LlmEndpointConfig {
  /** official = DeepSeek 官方账户(默认, 现状); bailian = 阿里云百炼(同模型同价, 扣阿里云的钱) */
  deepseekVia: "official" | "bailian";
  deepseekApiKey?: string;
  qwenApiKey?: string;
  /** 逃生口: 显式覆盖 baseURL(留空 = 按 deepseekVia 取默认) */
  deepseekBaseUrl?: string;
  qwenBaseUrl?: string;
}

export interface LlmConfigIssue {
  level: "error" | "warn";
  code: string;
  message: string;
}

export interface ResolvedEndpoints {
  deepseek: LlmEndpoint | null;
  qwen: LlmEndpoint | null;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function isBailianHost(url: string): boolean {
  return /^https?:\/\/[^/]*dashscope[^/]*\.aliyuncs\.com/i.test(url.trim());
}

function isDeepSeekHost(url: string): boolean {
  return /^https?:\/\/(api\.)?deepseek\.com/i.test(url.trim());
}

/**
 * 解析出两个 provider 各自的接入点。
 *
 * ⚠️ 行为兼容: 判定"有没有 key"沿用原来的真值判断(不把占位值当没配),
 *    以免改变现有部署的降级路径; 占位值只在 checkLlmEndpointConfig 里出警告。
 */
export function resolveLlmEndpoints(cfg: LlmEndpointConfig): ResolvedEndpoints {
  const viaBailian = cfg.deepseekVia === "bailian";

  const deepseekBaseUrl = trimBase(
    cfg.deepseekBaseUrl?.trim() || (viaBailian ? BAILIAN_OPENAI_BASE_URL : DEEPSEEK_OFFICIAL_BASE_URL)
  );
  // key 跟着开关走 —— 这是整个文件的重点: 不给"只改一半"的机会
  const deepseekKey = viaBailian ? cfg.qwenApiKey : cfg.deepseekApiKey;

  const qwenBaseUrl = trimBase(cfg.qwenBaseUrl?.trim() || BAILIAN_OPENAI_BASE_URL);

  return {
    deepseek: deepseekKey
      ? {
          provider: "deepseek",
          baseUrl: deepseekBaseUrl,
          apiKey: deepseekKey,
          keySource: viaBailian ? "QWEN_API_KEY" : "DEEPSEEK_API_KEY",
          billingAccount: viaBailian ? "bailian" : "deepseek",
        }
      : null,
    qwen: cfg.qwenApiKey
      ? {
          provider: "qwen",
          baseUrl: qwenBaseUrl,
          apiKey: cfg.qwenApiKey,
          keySource: "QWEN_API_KEY",
          billingAccount: "bailian",
        }
      : null,
  };
}

/**
 * 启动期自检 —— **不发任何网络请求**(更不发计费请求), 纯静态配对校验。
 * 能查出来的都是"一跑必 401/404"的死配置, 没必要等线上烧一整轮生成才发现。
 */
export function checkLlmEndpointConfig(cfg: LlmEndpointConfig): LlmConfigIssue[] {
  const issues: LlmConfigIssue[] = [];
  const viaBailian = cfg.deepseekVia === "bailian";
  const { deepseek, qwen } = resolveLlmEndpoints(cfg);

  // ① 开关切了百炼却没有百炼的 key
  if (viaBailian && !cfg.qwenApiKey) {
    issues.push({
      level: "error",
      code: "bailian_key_missing",
      message:
        "DEEPSEEK_VIA=bailian(走阿里云百炼)但 QWEN_API_KEY 没配 —— 百炼用的是阿里云 key, " +
        "不是 DeepSeek 的 key。请在 .env 配 QWEN_API_KEY(百炼控制台的 API-KEY), 或把 DEEPSEEK_VIA 改回 official。",
    });
  }

  // ② key 是占位值(等于没配, 但真值判断会让它一路打到 401)
  for (const [name, key] of [
    ["DEEPSEEK_API_KEY", cfg.deepseekApiKey],
    ["QWEN_API_KEY", cfg.qwenApiKey],
  ] as const) {
    if (key && PLACEHOLDER_KEYS.has(key.trim())) {
      issues.push({
        level: "warn",
        code: "placeholder_key",
        message: `${name} 还是 .env.example 里的占位值 "${key}" —— 用它调用一律 401, 等同于没配。`,
      });
    }
  }

  // ③ 官方账户没 key: 不是错误(会自动降级到 qwen), 但要说一声
  if (!viaBailian && !cfg.deepseekApiKey) {
    issues.push({
      level: "warn",
      code: "deepseek_key_missing",
      message:
        "DEEPSEEK_API_KEY 未配置 —— DeepSeek 线路不可用, 所有任务会落到 Qwen(内容生成质量与成本都会变)。" +
        "若是想改用百炼跑 deepseek 模型, 设 DEEPSEEK_VIA=bailian(baseURL 与 key 会一起切)。",
    });
  }

  // ④ baseURL 与 key 来源"张冠李戴" —— 本次改动最容易配错的点, 一律 error
  if (deepseek) {
    if (isBailianHost(deepseek.baseUrl) && deepseek.keySource === "DEEPSEEK_API_KEY") {
      issues.push({
        level: "error",
        code: "baseurl_key_mismatch",
        message:
          `DEEPSEEK_BASE_URL 指向阿里云百炼(${deepseek.baseUrl})但 key 仍取自 DEEPSEEK_API_KEY —— ` +
          "百炼不认 DeepSeek 的 key, 每次调用都会 401(而 401 不触发 Qwen 兜底, 整条生成链路会静默产废稿)。" +
          "正确做法: 只设 DEEPSEEK_VIA=bailian, baseURL 与 key 会成对切换, 不要手改 DEEPSEEK_BASE_URL。",
      });
    }
    if (isDeepSeekHost(deepseek.baseUrl) && deepseek.keySource === "QWEN_API_KEY") {
      issues.push({
        level: "error",
        code: "baseurl_key_mismatch",
        message:
          `DEEPSEEK_VIA=bailian 但 DEEPSEEK_BASE_URL 被手改回 DeepSeek 官方(${deepseek.baseUrl}) —— ` +
          "拿阿里云的 key 打 DeepSeek 官方门, 必 401。要走官方就把 DEEPSEEK_VIA 改回 official 并清空 DEEPSEEK_BASE_URL。",
      });
    }
  }

  // ⑤ 百炼域名却不是 OpenAI 兼容路径(最常见: 抄了 DASHSCOPE_BASE_URL 的 /api/v1) → 必 404
  for (const ep of [deepseek, qwen]) {
    if (!ep) continue;
    if (isBailianHost(ep.baseUrl) && !/\/compatible-mode\/v1$/i.test(ep.baseUrl)) {
      issues.push({
        level: "error",
        code: "bailian_path_wrong",
        message:
          `${ep.provider} 的 baseURL 用了百炼域名但路径不是 OpenAI 兼容端点(当前 ${ep.baseUrl})。` +
          `正确值: ${BAILIAN_OPENAI_BASE_URL} 。注意别抄 DASHSCOPE_BASE_URL(=/api/v1, 那是百炼原生接口, 给 TTS/声音克隆用)。`,
      });
    }
    if (!/^https?:\/\//i.test(ep.baseUrl)) {
      issues.push({
        level: "error",
        code: "baseurl_malformed",
        message: `${ep.provider} 的 baseURL 不是合法 http(s) 地址: ${ep.baseUrl}`,
      });
    }
    if (/\/chat\/completions$/i.test(ep.baseUrl)) {
      issues.push({
        level: "error",
        code: "baseurl_malformed",
        message:
          `${ep.provider} 的 baseURL 不要带 /chat/completions(代码会自己拼): ${ep.baseUrl}`,
      });
    }
  }

  return issues;
}

// ---------- 读 env 的薄包装 ----------

function currentConfig(): LlmEndpointConfig {
  return {
    deepseekVia: env.DEEPSEEK_VIA,
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    qwenApiKey: env.QWEN_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    qwenBaseUrl: env.QWEN_BASE_URL,
  };
}

/** 取某个 provider 的接入点(缺 key 返回 null, 与原 getProviderMeta 语义一致) */
export function getLlmEndpoint(provider: LlmProviderName): LlmEndpoint | null {
  return resolveLlmEndpoints(currentConfig())[provider];
}

/** 记账用: 这个 provider 的钱实际从哪个账户扣 */
export function getBillingAccount(provider: string): BillingAccount {
  if (provider === "qwen") return "bailian";
  if (provider === "deepseek") return env.DEEPSEEK_VIA === "bailian" ? "bailian" : "deepseek";
  return "deepseek";
}

/** 一行人话描述当前 LLM 接入点, 给启动日志/自检脚本用(不打印 key) */
export function describeLlmEndpoints(): string {
  const { deepseek, qwen } = resolveLlmEndpoints(currentConfig());
  const one = (ep: LlmEndpoint | null, label: string) =>
    ep ? `${label}=${ep.baseUrl}(key:${ep.keySource}, 扣费:${ep.billingAccount})` : `${label}=未配置`;
  return `${one(deepseek, "deepseek")} | ${one(qwen, "qwen")}`;
}

/**
 * 启动期调用: 打日志 + 生产环境遇 error 级配错直接退出。
 *
 * 为什么生产要 exit: baseURL/key 配错 = 100% 调用 401, 而 401 不触发兜底,
 * 系统会"看起来在跑"却整天产废稿(7-24 事故原型)。宁可 pm2 重启循环喊出来,
 * 也不要静默产废。warn 级永远不退出。
 */
export function assertLlmEndpointConfig(): LlmConfigIssue[] {
  const issues = checkLlmEndpointConfig(currentConfig());
  for (const issue of issues) {
    if (issue.level === "error") logger.error({ code: issue.code }, `❌ LLM 配置错误: ${issue.message}`);
    else logger.warn({ code: issue.code }, `⚠️ LLM 配置提醒: ${issue.message}`);
  }

  logger.info(`🔌 LLM 接入点: ${describeLlmEndpoints()}`);

  const hasError = issues.some((i) => i.level === "error");
  if (hasError && env.NODE_ENV === "production") {
    console.error("❌ LLM baseURL/API Key 配对错误, 拒绝带病启动。逐条修完再起:");
    for (const i of issues.filter((x) => x.level === "error")) console.error(`  - ${i.message}`);
    process.exit(1);
  }
  return issues;
}
