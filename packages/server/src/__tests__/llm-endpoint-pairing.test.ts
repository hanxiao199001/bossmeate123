/**
 * 7-26 LLM 接入点可配置 —— baseURL 与 API Key **成对**校验。
 *
 * 背景: DeepSeek 官方余额见底, 百炼上有同名 deepseek-v4-pro 且同价, 改 baseURL 即可继续跑。
 * 风险点(本测试存在的理由): 切 baseURL 却忘了切 key → 每次调用 401 → 401 不触发 qwen 兜底
 *   → 整条生成链路静默产废稿(7-24 事故原型)。所以:
 *   1. 默认(不配任何新变量)行为必须与改造前**逐字节一致**
 *   2. 一个开关 DEEPSEEK_VIA 同时切 baseURL 与 key
 *   3. 各种"只改一半"的配错组合必须在启动期就被静态识别出来(不联网、不发计费请求)
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../config/env.js", () => ({
  env: { NODE_ENV: "test", DEEPSEEK_VIA: "official", DEEPSEEK_API_KEY: "sk-ds", QWEN_API_KEY: "sk-qwen" },
}));

const {
  resolveLlmEndpoints,
  checkLlmEndpointConfig,
  getBillingAccount,
  DEEPSEEK_OFFICIAL_BASE_URL,
  BAILIAN_OPENAI_BASE_URL,
} = await import("../services/ai/llm-endpoints.js");

const OFFICIAL = { deepseekVia: "official" as const, deepseekApiKey: "sk-deepseek", qwenApiKey: "sk-ali" };
const BAILIAN = { deepseekVia: "bailian" as const, deepseekApiKey: "sk-deepseek", qwenApiKey: "sk-ali" };

const errorsOf = (issues: Array<{ level: string; code: string }>) =>
  issues.filter((i) => i.level === "error").map((i) => i.code);

describe("默认值 = 现状, 行为不变", () => {
  it("不配任何新变量: deepseek 走官方 v1 端点 + DEEPSEEK_API_KEY", () => {
    const { deepseek } = resolveLlmEndpoints(OFFICIAL);
    expect(deepseek?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(DEEPSEEK_OFFICIAL_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(deepseek?.apiKey).toBe("sk-deepseek");
    expect(deepseek?.keySource).toBe("DEEPSEEK_API_KEY");
    expect(deepseek?.billingAccount).toBe("deepseek");
  });

  it("qwen 恒定走百炼 OpenAI 兼容端点", () => {
    const { qwen } = resolveLlmEndpoints(OFFICIAL);
    expect(qwen?.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(BAILIAN_OPENAI_BASE_URL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(qwen?.keySource).toBe("QWEN_API_KEY");
    expect(qwen?.billingAccount).toBe("bailian");
  });

  it("默认配置无 error 级问题", () => {
    expect(errorsOf(checkLlmEndpointConfig(OFFICIAL))).toEqual([]);
  });

  it("缺 key 返回 null(与原 getProviderMeta 语义一致, 交给路由降级)", () => {
    expect(resolveLlmEndpoints({ deepseekVia: "official", qwenApiKey: "sk-ali" }).deepseek).toBeNull();
    expect(resolveLlmEndpoints({ deepseekVia: "official", deepseekApiKey: "sk-ds" }).qwen).toBeNull();
  });
});

describe("DEEPSEEK_VIA=bailian: 一个开关同时切 baseURL 与 key", () => {
  it("baseURL 切百炼, key 自动换成 QWEN_API_KEY, 扣费账户变百炼", () => {
    const { deepseek } = resolveLlmEndpoints(BAILIAN);
    expect(deepseek?.baseUrl).toBe(BAILIAN_OPENAI_BASE_URL);
    expect(deepseek?.apiKey).toBe("sk-ali"); // ← 关键: 绝不能还是 sk-deepseek
    expect(deepseek?.keySource).toBe("QWEN_API_KEY");
    expect(deepseek?.billingAccount).toBe("bailian");
  });

  it("切百炼后配置合法(无 error)", () => {
    expect(errorsOf(checkLlmEndpointConfig(BAILIAN))).toEqual([]);
  });

  it("切了百炼却没有 QWEN_API_KEY → error, 报错点名要配哪个变量", () => {
    const issues = checkLlmEndpointConfig({ deepseekVia: "bailian", deepseekApiKey: "sk-deepseek" });
    expect(errorsOf(issues)).toContain("bailian_key_missing");
    expect(issues.find((i) => i.code === "bailian_key_missing")?.message).toContain("QWEN_API_KEY");
  });
});

describe("配错识别(启动期纯静态, 不联网)", () => {
  it("只改 baseURL 不改开关(百炼域名 + DeepSeek key) → error", () => {
    const issues = checkLlmEndpointConfig({ ...OFFICIAL, deepseekBaseUrl: BAILIAN_OPENAI_BASE_URL });
    expect(errorsOf(issues)).toContain("baseurl_key_mismatch");
    expect(issues.find((i) => i.code === "baseurl_key_mismatch")?.message).toContain("401");
  });

  it("开关切了百炼却把 baseURL 手改回官方(阿里 key 打官方门) → error", () => {
    const issues = checkLlmEndpointConfig({ ...BAILIAN, deepseekBaseUrl: DEEPSEEK_OFFICIAL_BASE_URL });
    expect(errorsOf(issues)).toContain("baseurl_key_mismatch");
  });

  it("百炼域名但抄成原生 /api/v1(DASHSCOPE_BASE_URL) → error, 提示正确路径", () => {
    const issues = checkLlmEndpointConfig({
      ...BAILIAN,
      deepseekBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
    });
    expect(errorsOf(issues)).toContain("bailian_path_wrong");
    expect(issues.find((i) => i.code === "bailian_path_wrong")?.message).toContain("compatible-mode/v1");
  });

  it("QWEN_BASE_URL 写错路径同样被拦", () => {
    const issues = checkLlmEndpointConfig({ ...OFFICIAL, qwenBaseUrl: "https://dashscope.aliyuncs.com/api/v1" });
    expect(errorsOf(issues)).toContain("bailian_path_wrong");
  });

  it("baseURL 带上 /chat/completions 或不是 http(s) → error", () => {
    expect(
      errorsOf(checkLlmEndpointConfig({ ...OFFICIAL, deepseekBaseUrl: "https://api.deepseek.com/v1/chat/completions" })),
    ).toContain("baseurl_malformed");
    expect(errorsOf(checkLlmEndpointConfig({ ...OFFICIAL, deepseekBaseUrl: "api.deepseek.com" }))).toContain(
      "baseurl_malformed",
    );
  });

  it("末尾斜杠不算错(自动归一), 免得因为一个 / 拒绝启动", () => {
    const { deepseek } = resolveLlmEndpoints({ ...OFFICIAL, deepseekBaseUrl: "https://api.deepseek.com/v1/" });
    expect(deepseek?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(errorsOf(checkLlmEndpointConfig({ ...OFFICIAL, deepseekBaseUrl: "https://api.deepseek.com/v1/" }))).toEqual([]);
  });

  it("占位 key / 缺 DeepSeek key 只是 warn, 不拦启动", () => {
    const placeholder = checkLlmEndpointConfig({ ...OFFICIAL, deepseekApiKey: "your-deepseek-api-key" });
    expect(errorsOf(placeholder)).toEqual([]);
    expect(placeholder.map((i) => i.code)).toContain("placeholder_key");

    const missing = checkLlmEndpointConfig({ deepseekVia: "official", qwenApiKey: "sk-ali" });
    expect(errorsOf(missing)).toEqual([]);
    expect(missing.map((i) => i.code)).toContain("deepseek_key_missing");
  });
});

describe("计费归属(切百炼后账不能记串)", () => {
  it("默认 official: deepseek 记 deepseek 账, qwen 记百炼账", () => {
    expect(getBillingAccount("deepseek")).toBe("deepseek");
    expect(getBillingAccount("qwen")).toBe("bailian");
  });

  it("同一个 provider 名, 扣费账户由 DEEPSEEK_VIA 决定", () => {
    expect(resolveLlmEndpoints(OFFICIAL).deepseek?.billingAccount).toBe("deepseek");
    expect(resolveLlmEndpoints(BAILIAN).deepseek?.billingAccount).toBe("bailian");
  });
});
