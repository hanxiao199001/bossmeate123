/**
 * 5-22 PR #214 — CAR 显示升级为折线图(图二形式).
 * carIndex 原值即百分数 → 折线图 percentMode(不×100); carIndex===0 视为未公布剔除;
 * ≥2点画折线 / 1点回退文字 / 0点只显风险等级; 阈值说明 <5% 低风险.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";
const CHART = "../services/publisher/svg-charts/car-history-line-chart.ts";

describe("PR #214: 折线图 percentMode (不×100)", () => {
  it("图表函数支持 percentMode 参数", async () => {
    const src = await readSrc(CHART);
    expect(src).toMatch(/percentMode = false/);
  });
  it("percentMode 时值标签/Y轴不再×100", async () => {
    const src = await readSrc(CHART);
    expect(src).toMatch(/\(percentMode \? p\.v : p\.v \* 100\)\.toFixed\(2\)/);
    expect(src).toMatch(/\(percentMode \? vMax : vMax \* 100\)\.toFixed/);
  });
});

describe("PR #214: CAR 块用折线图 + 零值剔除 + 点数自适应", () => {
  it("剔除 carIndex===0 (未公布)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/\.filter\(\(d\) => typeof d\.carIndex === "number" && d\.carIndex > 0\)/);
  });
  it("≥2点画折线(percentMode=true), 1点回退文字", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/pts\.length >= 2/);
    expect(src).toMatch(/renderCarHistoryLineChart\(pts, riskLevel, true\)/);
    expect(src).toMatch(/pts\.length === 1/);
  });
  it("既无风险等级也无有效点 → 不渲染", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(!riskText && pts\.length === 0\) return "";/);
  });
  it("仍锁 jcarindex 源 + 阈值说明 <5% 低风险", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/raw\.source !== "jcarindex"/);
    expect(src).toMatch(/&lt;5% 为低风险/);
  });
});
