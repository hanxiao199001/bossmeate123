/**
 * 假兜底守卫的账户维度 (9-01)。
 *
 * 【背景】8-31 事故: 主 deepseek-v4-pro / 备 qwen-plus, 阿里云百炼账户欠费,
 * 两个在 14 秒内一起挂, 370 篇内容失败, 当日失败率 60%。
 *
 * 而 `findDegenerateFallbacks()` 当天**一条都没报** —— 它比的是 `providerName`,
 * "deepseek" ≠ "qwen" → 判为"跨厂商, 安全"。但 `DEEPSEEK_VIA=bailian` 从 7-26 起就开着,
 * 名字里的 "deepseek" 只是路由名, baseURL 与 key 都是百炼的。
 *
 * ▎ 一个用来检测假冗余的检查器, 自己把「不同的模型」当成了「不同的失败点」——
 * ▎ 而这正是那次事故的全部内容。
 *
 * 这组用例锁的就是这件事: **判定必须按"谁付钱", 不是按厂商名。**
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const ENV: Record<string, unknown> = {};
vi.mock("../config/env.js", () => ({ env: new Proxy({}, { get: (_t, k) => ENV[k as string] }) }));

function setEnv(deepseekVia: "official" | "bailian") {
  Object.assign(ENV, {
    DEEPSEEK_VIA: deepseekVia,
    DEEPSEEK_API_KEY: "dk", QWEN_API_KEY: "qk",
    DEEPSEEK_MODEL_CHAT: "deepseek-v4-pro",
    DEEPSEEK_MODEL_REASONER: "deepseek-v4-pro",
    QWEN_MODEL_PLUS: "qwen-plus", QWEN_MODEL_MAX: "qwen-max",
    MODEL_CIRCUIT_BREAKER_THRESHOLD: 5, AI_FALLBACK_STRATEGY: "serial",
  });
}

beforeEach(() => { vi.resetModules(); });

async function load(via: "official" | "bailian") {
  setEnv(via);
  vi.resetModules();
  return await import("../services/ai/model-router.js");
}

describe("🔴 判据按「谁付钱」而不是厂商名", () => {
  it("DEEPSEEK_VIA=bailian: deepseek/qwen 扣同一个账户 → 必须报 same_billing_account", async () => {
    const { findDegenerateFallbacks } = await load("bailian");
    const issues = findDegenerateFallbacks();
    const acct = issues.filter((i) => i.problem === "same_billing_account");
    // 这就是 8-31 那天应该响而没响的告警
    expect(acct.length).toBeGreaterThan(0);
    expect(acct[0].billingAccount).toBe("bailian");
    // content_generation 是 8-31 真正烧掉 370 篇的那条槽
    expect(acct.map((i) => i.taskType)).toContain("content_generation");
  });

  it("DEEPSEEK_VIA=official: 两条路径真的跨账户 → 不报 same_billing_account", async () => {
    const { findDegenerateFallbacks } = await load("official");
    const issues = findDegenerateFallbacks();
    expect(issues.filter((i) => i.problem === "same_billing_account")).toHaveLength(0);
  });

  it("🔴 同一份路由表, 只改 DEEPSEEK_VIA 就该改变判定 —— 锁住「账户是独立维度」这件事本身", async () => {
    const bailian = (await load("bailian")).findDegenerateFallbacks();
    const official = (await load("official")).findDegenerateFallbacks();
    const n = (xs: Array<{ problem: string }>) => xs.filter((i) => i.problem === "same_billing_account").length;
    expect(n(bailian)).toBeGreaterThan(n(official));
  });
});

describe("原有的同模型判据不受影响", () => {
  it("quality_check(primary/fallback 同为 deepseek-v4-pro)仍按同模型那条走, 不被账户判据顶掉", async () => {
    const { findDegenerateFallbacks } = await load("official");
    const qc = findDegenerateFallbacks().find((i) => i.taskType === "quality_check");
    // 它在 DEGENERATE_FALLBACK_ALLOWED 里声明了补偿槽, 官方账户下补偿槽跨账户 → 合规, 不报
    expect(qc?.problem).not.toBe("same_billing_account");
  });

  it("bailian 下补偿槽与被补偿槽同账户 → compensator_same_vendor(原来这里恒判安全)", async () => {
    const { findDegenerateFallbacks } = await load("bailian");
    const qc = findDegenerateFallbacks().find((i) => i.taskType === "quality_check");
    expect(qc?.problem).toBe("compensator_same_vendor");
    expect(qc?.billingAccount).toBe("bailian");
  });
});

describe("告警不许静默", () => {
  it("assertNoDegenerateFallback 永不抛(7-30 血的教训: 抛会让服务起不来)", async () => {
    const { assertNoDegenerateFallback } = await load("bailian");
    expect(() => assertNoDegenerateFallback()).not.toThrow();
  });
});
