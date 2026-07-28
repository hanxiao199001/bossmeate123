/**
 * 7-28 ②b —— chat() 主备全挂: 从"返回一句中文道歉文案当 content"改成"生产链路能知道失败了"。
 *
 * 事故原型(7-27): title-generator 的"按行拆"兜底把 "抱歉，AI暂时无法响应，请稍后重试。"
 *   当成了候选标题, 一篇标题=占位文的文章拿着六维 80 分、status=generated 溜进公众号草稿箱。
 *   当时 28 个 chat() 调用点里只有 3 个检查这个文案。
 *
 * **本次采用折中方案而不是全量抛异常**, 本测试同时锁住"改了什么"和"刻意没改什么":
 *   - 默认行为零变化(仍返回兜底文案) → 28 个调用点无一被动受影响, 客服/工坊实时链路照旧兜底话术;
 *   - 新增 `throwOnExhausted: true` 逐点开启, 只开在"产物会落库、会对外"的生产链路;
 *   - 新增结构化字段 `ok` —— 不想改控制流的调用点可以只读它, 不必再各自抄兜底文案字符串。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  selectModelMock: vi.fn(),
  getModelPairMock: vi.fn(),
  strategy: { value: "serial" as "serial" | "race" },
}));

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../config/env.js", () => ({
  env: { NODE_ENV: "test", AI_FALLBACK_STRATEGY: "serial", AI_REQUEST_TIMEOUT_MS: 100, AI_ARTICLE_TIMEOUT_MS: 100, AI_QUALITY_CHECK_TIMEOUT_MS: 100, AI_FAST_TIMEOUT_MS: 100 },
}));
vi.mock("../services/ai/model-router.js", () => ({
  modelRouter: {
    getFallbackStrategy: () => h.strategy.value,
    selectModel: h.selectModelMock,
    getModelPair: h.getModelPairMock,
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));
vi.mock("../services/billing/llm-cost.js", () => ({ recordLlmUsage: vi.fn(async () => undefined) }));
vi.mock("../utils/retry.js", () => ({ withRetry: (fn: () => unknown) => fn() })); // 免得重试把用例拖慢

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { chat, isAiUnavailableError, AiUnavailableError } = await import("../services/ai/chat-service.js");
const { AI_FALLBACK_NO_MODEL, AI_FALLBACK_UNAVAILABLE, isAiFallbackText } = await import("../services/ai/fallback-messages.js");

const PROVIDER = { name: "deepseek", model: "deepseek-chat", apiKey: "k", baseUrl: "http://fake.local", maxTokens: 4096 };
const REQ = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "u", conversationId: "c", message: "hi" };

beforeEach(() => {
  fetchMock.mockReset();
  h.selectModelMock.mockReset();
  h.getModelPairMock.mockReset();
  h.strategy.value = "serial";
});

describe("默认行为(不传 throwOnExhausted) —— 零回归", () => {
  it("无可用模型 → 仍返回兜底文案, 但带 ok:false 供调用方结构化判断", async () => {
    h.selectModelMock.mockReturnValue(null);
    const r = await chat({ ...REQ });
    expect(r.content).toBe(AI_FALLBACK_NO_MODEL);
    expect(r.ok).toBe(false);
    expect(isAiFallbackText(r.content)).toBe(true);
  });

  it("主备全挂 → 仍返回兜底文案 + ok:false(客服/工坊等实时链路继续拿到人话兜底)", async () => {
    h.selectModelMock.mockReturnValue(PROVIDER);
    fetchMock.mockRejectedValue(new Error("This operation was aborted"));
    const r = await chat({ ...REQ });
    expect(r.content).toBe(AI_FALLBACK_UNAVAILABLE);
    expect(r.ok).toBe(false);
  });

  it("成功时 ok:true —— `if (!res.ok)` 这种写法不会误伤正常返回", async () => {
    h.selectModelMock.mockReturnValue(PROVIDER);
    fetchMock.mockResolvedValue({
      ok: true, text: async () => "",
      json: async () => ({ choices: [{ message: { content: "正常回复" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    });
    const r = await chat({ ...REQ });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("正常回复");
  });
});

describe("throwOnExhausted:true —— 生产链路(生成/质检)拿到显式失败", () => {
  it("无可用模型 → 抛 AiUnavailableError(kind=no_model), 绝不返回可被当正文的文案", async () => {
    h.selectModelMock.mockReturnValue(null);
    await expect(chat({ ...REQ, throwOnExhausted: true })).rejects.toThrow(AiUnavailableError);
    await expect(chat({ ...REQ, throwOnExhausted: true })).rejects.toMatchObject({ kind: "no_model" });
  });

  it("主备全挂 → 抛 AiUnavailableError(kind=exhausted)", async () => {
    h.selectModelMock.mockReturnValue(PROVIDER);
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(chat({ ...REQ, throwOnExhausted: true })).rejects.toMatchObject({ kind: "exhausted" });
  });

  it("竞速模式两个都挂 → 同样抛(不被那层兜底 catch 吞回成文案)", async () => {
    h.strategy.value = "race";
    h.getModelPairMock.mockReturnValue({ primary: PROVIDER, secondary: { ...PROVIDER, name: "qwen", model: "qwen-plus" } });
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(chat({ ...REQ, throwOnExhausted: true })).rejects.toMatchObject({ kind: "exhausted" });
  });

  it("成功时行为不变(开关只在失败路径生效)", async () => {
    h.selectModelMock.mockReturnValue(PROVIDER);
    fetchMock.mockResolvedValue({
      ok: true, text: async () => "",
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }),
    });
    const r = await chat({ ...REQ, throwOnExhausted: true });
    expect(r.content).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("isAiUnavailableError 按 name 判(跨模块实例也成立, 不靠 instanceof)", () => {
    const fake = new Error("x"); fake.name = "AiUnavailableError";
    expect(isAiUnavailableError(fake)).toBe(true);
    expect(isAiUnavailableError(new Error("普通错误"))).toBe(false);
  });
});

describe("哪些调用点开了 throwOnExhausted —— 决策留痕(改了别忘同步)", () => {
  it("已开: 六维质检 / 红线 / 风格 / 平台规则 / 标题生成 / 正文生成", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p: string) => readFileSync(new URL(`../services/${p}`, import.meta.url), "utf8");

    const qc = read("content-engine/quality-check-v2.ts");
    // 四处 chat() 全部开启(红线/风格/平台/六维)
    expect(qc.match(/throwOnExhausted: true/g)?.length).toBe(4);
    expect(read("content-engine/title-generator.ts")).toContain("throwOnExhausted: true");
    expect(read("content-engine/format-generators.ts")).toContain("throwOnExhausted: true");
  });

  it("刻意没开: 客服链路(kf-responder) —— 实时对话要的就是一句人话兜底, 抛异常等于无回复", async () => {
    const { readFileSync } = await import("node:fs");
    const kf = readFileSync(new URL("../services/work-wechat/kf-responder.ts", import.meta.url), "utf8");
    expect(kf).not.toContain("throwOnExhausted");
  });
});
