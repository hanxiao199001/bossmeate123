/**
 * 5-22 PR #213 — 重启 CAR 显示, 数据源锁死 jcarindex (权威).
 * 语义(页面核实): carIndex 是 CAR 风险指数, 原值即百分数(0.87→"0.87%"), 非占比, 不×100.
 * 安全: 只渲染 source==="jcarindex"; AI CAR prose 保持止血(防幻觉); CAR 风险并入规则派生避坑项.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #213: CAR 显示重启 (jcarindex 源)", () => {
  it("只渲染 source===jcarindex, 否则不显示", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(!raw \|\| raw\.source !== "jcarindex" \|\|[\s\S]{0,80}?return "";/);
  });
  it("值按 %% 显示, 不×100 (carIndex 原值即百分数)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/r\.carIndex\.toFixed\(2\)\}%/);
    // 不能再出现旧的 ×100 占比处理
    expect(src).not.toMatch(/carIndex \* 100\)\.toFixed/);
  });
  it("风险等级 低/中/高 + 问题文章数 + 来源标注", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/学术诚信风险/);
    expect(src).toMatch(/问题文章数/);
    expect(src).toMatch(/数据来源：jcarindex/);
  });
  it("CAR 块无条件接入 (函数自守门), 不再依赖 typesSet", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/sections\.push\(renderCarHistoryBlock\(journal\)\);\s+\/\/\s+6/);
    expect(src).not.toMatch(/if \(typesSet\.has\("car-history-line"\)\) sections\.push\(renderCarHistoryBlock/);
  });
});

describe("PR #213: 准确性护栏", () => {
  it("AI CAR prose (renderCarRiskAnalysis) 仍止血 — 防幻觉", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderCarRiskAnalysis[\s\S]{0,200}?return "";/);
  });
  it("CAR 风险(中/高)并入规则派生避坑项", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/carRaw\?\.source === "jcarindex" && \(carRaw\.riskRankText === "中" \|\| carRaw\.riskRankText === "高"\)/);
  });
});
