/**
 * 简报成本拆分四个数 (9-04)。
 *
 * 【为什么加】简报此前只报「今日花费 X 元」一个总数, 而这个数**答不了任何要决策的问题**:
 * 钱是花在新内容上还是补积压? 视频占多少? 撞顶了吗?
 *
 * 9-01/9-02 各烧 ¥162/¥166, 简报里只是"今日花费 162 元"一行 ——
 * 而真相是**积压重跑把新内容挤掉了**, 那个信息在总额里完全看不见。
 */
import { describe, it, expect } from "vitest";
import { renderCostBreakdown, bjDayStartIso, type CostBreakdown } from "../services/ops/cost-breakdown.js";

const ok = (o: Partial<CostBreakdown> = {}): CostBreakdown => ({
  totalCents: 1157, retryCents: 0, videoCents: 0, llmCents: 1157, cappedAt: null, error: null, ...o,
});

describe("四个数都要出现", () => {
  it("总额 = 文章/AI + 视频, 三个数同行可对账", () => {
    const out = renderCostBreakdown(ok({ totalCents: 3000, llmCents: 1200, videoCents: 1800 })).join("\n");
    expect(out).toContain("30.00");
    expect(out).toContain("12.00");
    expect(out).toContain("18.00");
  });

  it("重跑为 0 时明说「全花在新内容上」, 而不是省略这一行", () => {
    // 省略会让读者不知道是"没有重跑"还是"没统计" —— 沉默的指标会被读成"我是不是该管"
    const out = renderCostBreakdown(ok()).join("\n");
    expect(out).toContain("重跑积压 0 元");
    expect(out).toContain("全花在新内容上");
  });

  it("重跑非 0 时报金额 + 占比 + 后果", () => {
    const out = renderCostBreakdown(ok({ totalCents: 10000, retryCents: 4000 })).join("\n");
    expect(out).toContain("40.00");
    expect(out).toContain("40%");
    expect(out).toMatch(/挤占.*新内容/);
  });

  it("未撞顶也要明说, 不留空", () => {
    expect(renderCostBreakdown(ok()).join("\n")).toContain("未触达日成本上限");
  });

  it("撞顶时报时刻, 并说清「顺延不是丢弃」", () => {
    const out = renderCostBreakdown(ok({ cappedAt: "14:23" })).join("\n");
    expect(out).toContain("14:23");
    expect(out).toMatch(/顺延.*不是丢弃/);
  });
});

describe("🔴 查不出来 ≠ 今天没花钱", () => {
  it("error 非空时说「没查成」, 且不出现任何金额结论", () => {
    const out = renderCostBreakdown({
      totalCents: 0, retryCents: 0, videoCents: 0, llmCents: 0, cappedAt: null, error: "connection refused",
    }).join("\n");
    expect(out).toMatch(/没查成/);
    expect(out).toContain("connection refused");
    // "今日总额 0.00 元" 是一句读起来像好消息的假话
    expect(out).not.toContain("今日总额");
    expect(out).not.toContain("未触达");
  });
});

describe("北京时间当天口径", () => {
  it("北京 09:00 → 起点是当天 00:00 BJ(= 前一天 16:00 UTC)", () => {
    // 2026-09-04 09:00 BJ = 2026-09-04T01:00:00Z
    expect(bjDayStartIso(new Date("2026-09-04T01:00:00Z"))).toBe("2026-09-03T16:00:00.000Z");
  });

  it("北京 00:30(= 前一天 16:30 UTC) 仍算当天, 不回退一天", () => {
    expect(bjDayStartIso(new Date("2026-09-03T16:30:00Z"))).toBe("2026-09-03T16:00:00.000Z");
  });

  it("北京 23:59 仍是同一起点", () => {
    expect(bjDayStartIso(new Date("2026-09-04T15:59:00Z"))).toBe("2026-09-03T16:00:00.000Z");
  });
});
