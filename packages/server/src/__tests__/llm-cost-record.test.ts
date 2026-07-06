/**
 * LLM 成本落库 — 行为测试(黑盒过 chat(), 非源码字面断言)。
 *
 * 锁定(战略评估薄弱点#2的修复):
 *   1. chat() 成功返回后自动 recordCost(kind:"llm") — 金额按价目表算, quantity=总token, note 含模型/任务
 *   2. 租户归属: request.tenantId 为真 uuid 直接用; 否则读 AsyncLocalStorage(skills 链路);
 *      两者皆无 → 不记账(cost_ledger.tenant_id 是 NOT NULL 外键, 宁可不记不能编)
 *   3. 价目表: 默认价 + LLM_PRICE_OVERRIDES 覆盖; 未知模型记 0 分但保留用量
 *   4. model="none"/零 token 的占位回复不记账
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  recordCostMock: vi.fn(async (_input: unknown) => undefined),
  selectModelMock: vi.fn(() => ({ name: "deepseek", model: "deepseek-chat", apiKey: "k", baseUrl: "http://fake.local", maxTokens: 4096 })),
}));

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    AI_FALLBACK_STRATEGY: "serial",
    AI_REQUEST_TIMEOUT_MS: 5000,
    AI_ARTICLE_TIMEOUT_MS: 8000,
    LLM_PRICE_OVERRIDES: '{"my-custom-model":{"in":100,"out":100},"bad-entry":{"in":"x"}}',
  },
}));
vi.mock("../services/ai/model-router.js", () => ({
  modelRouter: {
    getFallbackStrategy: () => "serial",
    selectModel: h.selectModelMock,
    getModelPair: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));
vi.mock("../services/billing/cost-ledger.js", () => ({ recordCost: h.recordCostMock }));

// fetch 打桩: 返回带真实 usage 的 OpenAI 兼容响应
const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
  }),
  text: async () => "",
}));
vi.stubGlobal("fetch", fetchMock);

const { chat } = await import("../services/ai/chat-service.js");
const { computeLlmCostCents, recordLlmUsage, runWithLlmCallAttribution, __resetPriceTableForTest } =
  await import("../services/billing/llm-cost.js");

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  h.recordCostMock.mockClear();
  fetchMock.mockClear();
  __resetPriceTableForTest();
});

describe("LLM 成本落库(chat() 出口自动记账)", () => {
  it("真实租户: chat 成功 → recordCost(kind:llm) 带金额/总token/模型注记", async () => {
    const res = await chat({ tenantId: TENANT_A, userId: "u1", conversationId: "c1", message: "你好", skillType: "daily_chat" });
    expect(res.content).toBe("你好");
    await vi.waitFor(() => expect(h.recordCostMock).toHaveBeenCalledTimes(1));

    const arg = h.recordCostMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.kind).toBe("llm");
    expect(arg.tenantId).toBe(TENANT_A);
    expect(arg.quantity).toBe(1500);
    // deepseek-chat: 1000/1M*200分 + 500/1M*800分 = 0.2 + 0.4 = 0.6 分
    expect(Math.abs((arg.amountCents as number) - 0.6)).toBeLessThan(1e-9);
    expect(String(arg.note)).toContain("deepseek/deepseek-chat");
    expect(String(arg.note)).toContain("in=1000 out=500");
  });

  it("skills 链路: AsyncLocalStorage 归属 — tenantId 非 uuid 时读 ALS", async () => {
    await runWithLlmCallAttribution({ tenantId: TENANT_B, userId: "u2" }, () =>
      chat({ tenantId: "system", userId: "skill-runtime", conversationId: "skill-article", message: "写一篇文章", skillType: "article" }),
    );
    await vi.waitFor(() => expect(h.recordCostMock).toHaveBeenCalledTimes(1));
    expect((h.recordCostMock.mock.calls[0][0] as Record<string, unknown>).tenantId).toBe(TENANT_B);
  });

  it("无真实租户且无 ALS: 不记账(NOT NULL 外键, 宁可不记)", async () => {
    await chat({ tenantId: "system", userId: "x", conversationId: "y", message: "hi", skillType: "daily_chat" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.recordCostMock).not.toHaveBeenCalled();
  });

  it("占位回复不记账: model=none 或零 token", async () => {
    await recordLlmUsage({ tenantId: TENANT_A, taskType: "t", model: "none", provider: "none", inputTokens: 0, outputTokens: 0 });
    await recordLlmUsage({ tenantId: TENANT_A, taskType: "t", model: "deepseek-chat", provider: "deepseek", inputTokens: 0, outputTokens: 0 });
    expect(h.recordCostMock).not.toHaveBeenCalled();
  });
});

describe("价目表(computeLlmCostCents)", () => {
  it("默认价: qwen-plus 100万入+100万出 = 80+200 = 280 分", () => {
    expect(computeLlmCostCents("qwen-plus", 1_000_000, 1_000_000)).toEqual({ cents: 280, priced: true });
  });
  it("deepseek-reasoner 默认价 400/1600", () => {
    expect(computeLlmCostCents("deepseek-reasoner", 1_000_000, 0).cents).toBe(400);
  });
  it("env 覆盖生效(新模型), 非法条目忽略", () => {
    expect(computeLlmCostCents("my-custom-model", 1_000_000, 0)).toEqual({ cents: 100, priced: true });
    expect(computeLlmCostCents("bad-entry", 1_000_000, 0).priced).toBe(false);
  });
  it("未知模型: 0 分 + priced=false(用量仍会被记)", () => {
    expect(computeLlmCostCents("gpt-4", 1_000_000, 1_000_000)).toEqual({ cents: 0, priced: false });
  });
});
