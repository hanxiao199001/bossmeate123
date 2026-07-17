/**
 * 7-18 效果看板纯函数单测。
 * effect-dashboard-utils.ts 无任何 IO/db/env 依赖，可直接 import（无需 mock db）。
 */
import { describe, it, expect } from "vitest";
import { fillTrendZeros, computeCoverage } from "../services/metrics/effect-dashboard-utils.js";

describe("7-18 效果看板 — fillTrendZeros 趋势补零", () => {
  const END = new Date("2026-07-18T00:00:00.000Z");

  it("返回长度 = days 的连续序列, 按日期升序, 末位=endDate", () => {
    const out = fillTrendZeros([], END, 7);
    expect(out).toHaveLength(7);
    expect(out[0]!.date).toBe("2026-07-12");
    expect(out[6]!.date).toBe("2026-07-18");
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.date > out[i - 1]!.date).toBe(true);
    }
  });

  it("空输入 → 全部补 0 (不编造数据)", () => {
    const out = fillTrendZeros([], END, 30);
    expect(out).toHaveLength(30);
    expect(out.every((p) => p.reads === 0)).toBe(true);
  });

  it("稀疏数据落到对应日期, 其余补 0", () => {
    const out = fillTrendZeros(
      [
        { date: "2026-07-18", reads: 500 },
        { date: "2026-07-15", reads: 120 },
      ],
      END,
      7,
    );
    const map = Object.fromEntries(out.map((p) => [p.date, p.reads]));
    expect(map["2026-07-18"]).toBe(500);
    expect(map["2026-07-15"]).toBe(120);
    expect(map["2026-07-16"]).toBe(0);
    expect(map["2026-07-12"]).toBe(0);
  });

  it("同日多条累加合并", () => {
    const out = fillTrendZeros(
      [
        { date: "2026-07-18", reads: 100 },
        { date: "2026-07-18", reads: 50 },
      ],
      END,
      3,
    );
    expect(out.find((p) => p.date === "2026-07-18")!.reads).toBe(150);
  });

  it("区间外的日期被忽略 (不越界渗入)", () => {
    const out = fillTrendZeros(
      [{ date: "2026-07-01", reads: 999 }], // 早于 7 天窗口
      END,
      7,
    );
    expect(out.every((p) => p.reads === 0)).toBe(true);
  });
});

describe("7-18 效果看板 — computeCoverage 覆盖率", () => {
  it("正常比例 → 0-100 整数", () => {
    expect(computeCoverage(8, 10)).toBe(80);
    expect(computeCoverage(1, 3)).toBe(33);
  });

  it("无发布记录 (published=0) → null 而非 0% (避免误导老板数据不全)", () => {
    expect(computeCoverage(0, 0)).toBeNull();
    expect(computeCoverage(5, 0)).toBeNull();
  });

  it("measured > published (回流含旧内容) → 封顶 100, 不超 100%", () => {
    expect(computeCoverage(12, 10)).toBe(100);
  });

  it("全覆盖", () => {
    expect(computeCoverage(10, 10)).toBe(100);
  });
});
