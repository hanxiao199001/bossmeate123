/**
 * 5-22 PR #214 — CAR 折线图组件支持 percentMode (jcarindex 值即%, 不×100).
 * 注: CAR 区块最终采用表格+文字(图三, 见 PR #215); 折线图组件保留 percentMode 备用.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
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
