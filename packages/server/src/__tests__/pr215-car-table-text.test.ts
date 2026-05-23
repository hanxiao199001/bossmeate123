/**
 * 5-22 PR #215 — CAR 显示改"表格+文字说明"(图三形式).
 * 文字说明规则生成(非AI): 各年CAR指数 + <5%低风险规则 + 结论(以jcarindex sciRiskRank为准, 不重算).
 * 表格: 年份×CAR指数, 0值标"未公布". 仍锁 jcarindex 源.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #215: CAR 表格+文字说明", () => {
  it("仍锁 jcarindex 源", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(!raw \|\| raw\.source !== "jcarindex"\) return "";/);
  });
  it("规则生成文字说明: 各年CAR + <5%规则 + 结论", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/const yearPhrase = known\.map/);
    expect(src).toMatch(/CAR 指数 &lt;5% 为低风险/);
    expect(src).toMatch(/可放心投稿/);
    expect(src).toMatch(/建议谨慎评估或避开/);
  });
  it("结论以 jcarindex 风险等级为准 (低/中/高), 不自行重算", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/rank === "高"[\s\S]{0,40}?rank === "中"[\s\S]{0,40}?rank === "低"/);
  });
  it("表格: 0值标'未公布', 非0显示 %", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/d\.carIndex > 0 \? `\$\{d\.carIndex\.toFixed\(2\)\}%`/);
    expect(src).toMatch(/未公布/);
  });
  it("无有效点且无风险等级 → 不渲染", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(known\.length === 0 && !riskText\) return "";/);
  });
  it("保留问题文章数 + 来源标注", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/问题文章数/);
    expect(src).toMatch(/数据来源：jcarindex/);
  });
});
