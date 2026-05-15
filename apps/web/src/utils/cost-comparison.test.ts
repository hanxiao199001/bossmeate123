import { describe, it, expect } from "vitest";
import { computeMetrics, DEFAULTS } from "./cost-comparison";

describe("computeMetrics — 5-16 PR 成本对比", () => {
  it("默认输入: 运营 44 篇/月 ¥227/篇，BossMate 300 篇/月 ¥10/篇", () => {
    const m = computeMetrics(DEFAULTS);
    expect(m.operatorOutputMonthly).toBe(44);
    expect(m.operatorCostPerArticle).toBeCloseTo(227.27, 1);
    expect(m.bossmateOutputMonthly).toBe(300);
    expect(m.bossmateCostPerArticle).toBe(10);
    expect(m.savePerMonth).toBe(7000);
    expect(m.savePerYear).toBe(84000);
    expect(m.roiMultiple).toBeCloseTo(22.73, 1);
  });

  it("salary 翻倍 → savePerMonth=17000 / savePerYear=204000", () => {
    const m = computeMetrics({ ...DEFAULTS, operatorSalaryMonthly: 20000 });
    expect(m.savePerMonth).toBe(17000);
    expect(m.savePerYear).toBe(204000);
  });

  it("工时: 1 运营 8h 产 2 篇 → 240min/篇；BossMate 5min/10 = 0.5min/篇；压缩 480x", () => {
    const m = computeMetrics(DEFAULTS);
    expect(m.operatorMinutesPerArticle).toBe(240);
    expect(m.bossmateMinutesPerArticle).toBe(0.5);
    expect(m.hourSaveMultiple).toBe(480);
  });

  it("operatorOutputDaily=0 边界 → 不抛 0 除错", () => {
    const m = computeMetrics({ ...DEFAULTS, operatorOutputDaily: 0 });
    expect(m.operatorCostPerArticle).toBe(0);
    expect(m.operatorMinutesPerArticle).toBe(0);
    expect(m.hourSaveMultiple).toBe(0);
  });
});
