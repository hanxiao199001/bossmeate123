/**
 * RoutedProvider — skills 主链路接入网关(战略评估薄弱点#1修复)的行为测试。
 *
 * 端到端: createRoutedProvider().chat() → 真 chat-service → mock fetch, 锁定:
 *   1. messages 映射保序(system 合并→systemPrompt→重组后与原序一致), 不丢不重
 *   2. temperature/maxTokens 逐调用透传到实际 HTTP 请求体; 不传保持原默认(0.7/路由表)
 *   3. ALS 租户归属端到端: runWithLlmCallAttribution 包住 → 成本记到该租户(kind:llm)
 *   4. 响应映射回 AIProvider 契约(ChatCompletionResponse); chatStream 兜底一次性回吐
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  recordCostMock: vi.fn(async (_input: unknown) => undefined),
}));

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../config/env.js", () => ({
  env: { NODE_ENV: "test", AI_FALLBACK_STRATEGY: "serial", AI_REQUEST_TIMEOUT_MS: 5000, AI_ARTICLE_TIMEOUT_MS: 8000 },
}));
vi.mock("../services/ai/model-router.js", () => ({
  modelRouter: {
    getFallbackStrategy: () => "serial",
    selectModel: () => ({ name: "deepseek", model: "deepseek-chat", apiKey: "k", baseUrl: "http://fake.local", maxTokens: 4096 }),
    getModelPair: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));
vi.mock("../services/billing/cost-ledger.js", () => ({ recordCost: h.recordCostMock }));

// 捕获实际发出的请求体
let lastBody: Record<string, unknown> & { messages: Array<{ role: string; content: string }> };
const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
  lastBody = init?.body ? JSON.parse(init.body) : null;
  return {
    ok: true,
    json: async () => ({
      choices: [{ index: 0, message: { role: "assistant", content: "生成结果" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    text: async () => "",
  };
});
vi.stubGlobal("fetch", fetchMock);

const { createRoutedProvider } = await import("../services/ai/routed-provider.js");
const { runWithLlmCallAttribution } = await import("../services/billing/llm-cost.js");

const TENANT = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  fetchMock.mockClear();
  h.recordCostMock.mockClear();
});

describe("RoutedProvider — skills 主链路走统一网关", () => {
  it("messages 保序重组 + temperature/maxTokens 透传到实际请求体", async () => {
    const provider = createRoutedProvider("article");
    const res = await provider.chat({
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });
    // 经 systemPrompt+context+message 重组后, 与 skills 原始入参逐条一致(无丢失/重复/换序)
    expect(lastBody.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
    expect(lastBody.temperature).toBe(0.3); // 旧直连语义保持: 0.3 不被网关默认值覆盖
    expect(lastBody.max_tokens).toBe(1024);
    expect(res).toEqual({ content: "生成结果", model: "deepseek-chat", inputTokens: 100, outputTokens: 50, finishReason: "stop" });
  });

  it("不传生成参数 → 保持原默认(temperature 0.7 / 路由表 maxTokens)", async () => {
    const provider = createRoutedProvider("video");
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(lastBody.temperature).toBe(0.7);
    expect(lastBody.max_tokens).toBe(4096);
  });

  it("多条 system 合并为一条(双换行连接), 不产生多 system 消息", async () => {
    const provider = createRoutedProvider("article");
    await provider.chat({
      messages: [
        { role: "system", content: "S1" },
        { role: "system", content: "S2" },
        { role: "user", content: "u" },
      ],
    });
    expect(lastBody.messages[0]).toEqual({ role: "system", content: "S1\n\nS2" });
    expect(lastBody.messages).toHaveLength(2);
  });

  it("ALS 租户归属端到端: worker 外层包 runWithLlmCallAttribution → 成本记到该租户", async () => {
    const provider = createRoutedProvider("article");
    await runWithLlmCallAttribution({ tenantId: TENANT, userId: "u", conversationId: "c" }, () =>
      provider.chat({ messages: [{ role: "user", content: "写一篇文章" }] }),
    );
    await vi.waitFor(() => expect(h.recordCostMock).toHaveBeenCalledTimes(1));
    const arg = h.recordCostMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tenantId).toBe(TENANT);
    expect(arg.kind).toBe("llm");
    expect(arg.quantity).toBe(150);
  });

  it("chatStream 兜底: 完整生成后一次性回吐 done:true(满足 AIProvider 契约)", async () => {
    const provider = createRoutedProvider("article");
    const chunks: unknown[] = [];
    const res = await provider.chatStream({ messages: [{ role: "user", content: "hi" }] }, (c) => chunks.push(c));
    expect(chunks).toEqual([{ content: "生成结果", done: true, inputTokens: 100, outputTokens: 50 }]);
    expect(res.content).toBe("生成结果");
  });
});
