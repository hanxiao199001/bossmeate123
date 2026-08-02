/**
 * 7-27 无人值守③ — LLM 日花费/日调用硬上限(billing/llm-guard) 单测。
 *
 * 锁定行为:
 *   1. judgeLlmCap 纯函数: 触顶熔断/未触顶放行/0=不限/总开关
 *   2. checkLlmDailyCap: 账本读取 + 触顶落 llm_cost_cap incident(同一天只落一次) + fail-open
 *   3. noteLlmSpend: 缓存窗口内的进程内增量也能触顶(不等 60s 缓存过期)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const selectQueue: Array<Row[] | Error> = [];
  function chain(result: Row[] | Error) {
    const target: Promise<Row[]> = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    target.catch(() => {});
    const proxy: unknown = new Proxy(function () {} as never, {
      get(_t, prop) {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[prop].bind(target);
        }
        return () => proxy;
      },
      apply() { return proxy; },
    });
    return proxy;
  }
  return { selectQueue, chain, recordIncident: vi.fn(async (_input?: unknown) => {}) };
});

vi.mock("../models/db.js", () => ({
  db: { select: () => h.chain(h.selectQueue.shift() ?? []) },
  testConnection: vi.fn(async () => true),
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/ops/incidents.js", () => ({
  recordIncident: h.recordIncident,
}));

const {
  judgeLlmCap,
  checkLlmDailyCap,
  noteLlmSpend,
  __resetLlmGuard,
  LLM_CAP_INCIDENT_KIND,
} = await import("../services/billing/llm-guard.js");
const { env } = await import("../config/env.js");

const CAP = { dailyCostCapYuan: 50, dailyCallCap: 2000, enabled: true };

beforeEach(() => {
  h.selectQueue.length = 0;
  h.recordIncident.mockClear();
  __resetLlmGuard();
});

describe("judgeLlmCap — 纯判定", () => {
  it("远低于上限 → 放行, usedPct 给两项取高者", () => {
    const v = judgeLlmCap({ costCents: 500, calls: 100 }, CAP); // 5 元/50 元=10%, 100/2000=5%
    expect(v.allowed).toBe(true);
    expect(v.usedPct).toBe(10);
  });

  it("日花费触顶 → 熔断, 原因是人话且写明取舍(宁可停产不烧余额)", () => {
    const v = judgeLlmCap({ costCents: 5000, calls: 10 }, CAP);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("硬上限 50 元");
    expect(v.reason).toContain("已停止内容生成");
  });

  // 8-02 断言翻转(红线 #13: 告警文案只陈述事实, 不写归因)。
  //   原用例叫"提示典型是失败重试打转" —— 那句归因在 08-01 事故当天就是错的:
  //   真实根因是行业月度一次性入队 593 行(平时 24), 每篇本就要 8~10 次调用, 与重试无关。
  //   而这句话很有说服力, 把排查带偏了半天。现在文案只给事实 + 可验证的对照数据。
  it("日调用次数触顶 → 熔断, 只给事实与可验证数据, **不给归因结论**", () => {
    const v = judgeLlmCap({ costCents: 100, calls: 2000 }, CAP);
    expect(v.allowed).toBe(false);
    // ✅ 事实
    expect(v.reason).toContain("2000 次");
    expect(v.reason).toContain("已停止内容生成");
    // ✅ 可验证的线索: 均价, 且写明怎么对照
    expect(v.reason).toContain("元/次");
    // ❌ 不许再出现"典型是…"这类下结论的措辞
    expect(v.reason).not.toContain("典型是");
  });

  it("上限设 0 = 该项不限; 两项都 0 或总开关关 → 永远放行", () => {
    expect(judgeLlmCap({ costCents: 999999, calls: 999999 }, { ...CAP, dailyCostCapYuan: 0, dailyCallCap: 0 }).allowed).toBe(true);
    expect(judgeLlmCap({ costCents: 999999, calls: 5 }, { ...CAP, dailyCostCapYuan: 0 }).allowed).toBe(true);
    expect(judgeLlmCap({ costCents: 999999, calls: 999999 }, { ...CAP, enabled: false }).allowed).toBe(true);
  });

  it("默认 env 值本身是开着的保险(50 元/2000 次), 不是 0=裸奔", () => {
    expect(env.LLM_DAILY_COST_CAP_YUAN).toBe(50);
    expect(env.LLM_DAILY_CALL_CAP).toBe(2000);
    expect(env.LLM_DAILY_CAP_ENABLED).toBe(true);
  });
});

describe("checkLlmDailyCap — 账本 + 告警 + fail-open", () => {
  it("账本未触顶 → 放行", async () => {
    h.selectQueue.push([{ cents: "1200", calls: "300" }]);
    const v = await checkLlmDailyCap();
    expect(v.allowed).toBe(true);
    expect(v.usage).toEqual({ costCents: 1200, calls: 300 });
  });

  it("账本触顶 → 熔断 + 落一条 llm_cost_cap; 同一天再触不重复落(防刷屏)", async () => {
    h.selectQueue.push([{ cents: String(env.LLM_DAILY_COST_CAP_YUAN * 100 + 1), calls: "10" }]);
    const v1 = await checkLlmDailyCap();
    expect(v1.allowed).toBe(false);
    expect(h.recordIncident).toHaveBeenCalledTimes(1);
    expect(h.recordIncident.mock.calls[0]![0]).toMatchObject({ kind: LLM_CAP_INCIDENT_KIND, severity: "error" });

    const v2 = await checkLlmDailyCap(); // 60s 缓存内, 不再查库
    expect(v2.allowed).toBe(false);
    expect(h.recordIncident).toHaveBeenCalledTimes(1);
  });

  it("noteLlmSpend: 缓存窗口内的增量把用量顶过线 → 立刻熔断, 不等缓存过期", async () => {
    const capCents = env.LLM_DAILY_COST_CAP_YUAN * 100;
    h.selectQueue.push([{ cents: String(capCents - 100), calls: "10" }]); // 差 1 元
    expect((await checkLlmDailyCap()).allowed).toBe(true);
    noteLlmSpend(200); // 进程内又花 2 元
    expect((await checkLlmDailyCap()).allowed).toBe(false);
  });

  it("账本读取失败 → fail-open 放行(别拿 DB 抖动换全线停产)", async () => {
    h.selectQueue.push(new Error("db down"));
    const v = await checkLlmDailyCap();
    expect(v.allowed).toBe(true);
  });
});
