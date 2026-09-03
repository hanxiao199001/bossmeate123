/**
 * LLM 真实单价 + 缓存计费 (9-03)。
 *
 * 【背景】`deepseek-v4-pro` 的单价此前是 7-26 **推算**出来的:
 * 按官网 $0.435/$0.87 折 ~7.14 汇率 ≈ ¥3.1/¥6.2，注释还写着「百炼与官网同价，这张表通用」。
 * 真实账单是 **¥12/¥24** —— 推算错了 3.9 倍。
 *
 * 后果不是"报表数字难看"，是**预算闸失灵了 5 周**：
 * `LLM_DAILY_COST_CAP_YUAN=50` 实际要烧到 ¥195 才触发，
 * 而 9-03 那次重跑风暴 3.5 小时的真实花费约 ¥105 —— 闸从头到尾没响过。
 *
 * ▎ 单价是**外部事实**，不许用汇率乘法算出来。以账单为准。
 *
 * 这组用例锁三件：真价、缓存不被重复计价、以及缓存价缺失时不给静默折扣。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const ENV: Record<string, unknown> = {};
vi.mock("../config/env.js", () => ({ env: new Proxy({}, { get: (_t, k) => ENV[k as string] }) }));
vi.mock("../services/ai/llm-endpoints.js", () => ({ getBillingAccount: () => "bailian" }));
vi.mock("../services/billing/cost-ledger.js", () => ({ recordCost: vi.fn(async () => undefined) }));

beforeEach(async () => {
  for (const k of Object.keys(ENV)) delete ENV[k];
  const m = await import("../services/billing/llm-cost.js");
  m.__resetPriceTableForTest();
});

async function load() { return await import("../services/billing/llm-cost.js"); }

describe("① 真实单价", () => {
  it("deepseek-v4-pro = ¥12/¥24 每 1M（不是推算出来的 ¥3.1/¥6.2）", async () => {
    const { computeLlmCostCents } = await load();
    // 1M in + 1M out = 1200 + 2400 分 = ¥36
    const r = computeLlmCostCents("deepseek-v4-pro", 1_000_000, 1_000_000);
    expect(r.priced).toBe(true);
    expect(r.cents).toBeCloseTo(3600, 5);
  });

  it("🔴 旧单价会让预算闸失灵：同一笔调用新旧差 3.9 倍", async () => {
    const { computeLlmCostCents } = await load();
    const now = computeLlmCostCents("deepseek-v4-pro", 1_000_000, 1_000_000).cents;
    const old = (1_000_000 / 1e6) * 310 + (1_000_000 / 1e6) * 620;   // 7-26 那版
    expect(now / old).toBeCloseTo(3.87, 1);
  });

  it("模型不在价目表 → priced=false 且 0 分（用量仍记，闸会看见 0 而不是崩）", async () => {
    const { computeLlmCostCents } = await load();
    expect(computeLlmCostCents("no-such-model", 1000, 1000)).toEqual({ cents: 0, priced: false });
  });
});

describe("② 缓存计费：inputTokens 已含缓存，不许算两遍", () => {
  it("100 万输入里 80 万命中缓存 → 20万×¥12 + 80万×¥1", async () => {
    const { computeLlmCostCents } = await load();
    const r = computeLlmCostCents("deepseek-v4-pro", 1_000_000, 0, 800_000);
    // 0.2*1200 + 0.8*100 = 240 + 80 = 320 分
    expect(r.cents).toBeCloseTo(320, 5);
  });

  it("🔴 不减去缓存部分就会重复计价 —— 锁住这个减法", async () => {
    const { computeLlmCostCents } = await load();
    const withCache = computeLlmCostCents("deepseek-v4-pro", 1_000_000, 0, 800_000).cents;
    const naiveDouble = (1_000_000 / 1e6) * 1200 + (800_000 / 1e6) * 100; // 忘了减
    expect(withCache).toBeLessThan(naiveDouble);
  });

  it("cachedTokens 缺省 = 0 → 全按未命中计价", async () => {
    const { computeLlmCostCents } = await load();
    expect(computeLlmCostCents("deepseek-v4-pro", 1_000_000, 0).cents).toBeCloseTo(1200, 5);
  });

  it("cachedTokens 超过 inputTokens（脏数据）时按 inputTokens 封顶，不出负数", async () => {
    const { computeLlmCostCents } = await load();
    const r = computeLlmCostCents("deepseek-v4-pro", 1000, 0, 999_999);
    expect(r.cents).toBeGreaterThanOrEqual(0);
    expect(r.cents).toBeCloseTo((1000 / 1e6) * 100, 6);
  });

  it("🔴 没有 cache 单价的模型：缓存部分按 in 计，不给静默折扣", async () => {
    const { computeLlmCostCents } = await load();
    // qwen-plus 表里没有 cache 价
    const a = computeLlmCostCents("qwen-plus", 1_000_000, 0, 500_000).cents;
    const b = computeLlmCostCents("qwen-plus", 1_000_000, 0, 0).cents;
    expect(a).toBe(b);   // 少算钱和多算钱一样是记错账
  });
});

describe("③ LLM_PRICE_OVERRIDES 可以热覆盖 cache 价", () => {
  it("override 带 cache 时生效", async () => {
    ENV.LLM_PRICE_OVERRIDES = JSON.stringify({ "deepseek-v4-pro": { in: 1200, out: 2400, cache: 50 } });
    const { computeLlmCostCents, __resetPriceTableForTest } = await load();
    __resetPriceTableForTest();
    expect(computeLlmCostCents("deepseek-v4-pro", 1_000_000, 0, 1_000_000).cents).toBeCloseTo(50, 5);
  });

  it("override 里 cache 非法 → 整条忽略，不静默用一半", async () => {
    ENV.LLM_PRICE_OVERRIDES = JSON.stringify({ "deepseek-v4-pro": { in: 999, out: 999, cache: -5 } });
    const { computeLlmCostCents, __resetPriceTableForTest } = await load();
    __resetPriceTableForTest();
    // 落回默认表的 1200，而不是采纳 in=999
    expect(computeLlmCostCents("deepseek-v4-pro", 1_000_000, 0).cents).toBeCloseTo(1200, 5);
  });
});
