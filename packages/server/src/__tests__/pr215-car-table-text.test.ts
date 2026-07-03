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
  it("规则生成文字说明: 各年CAR + <5%规则 + 结论 (7-03: 删'可放心投稿'承诺话术)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/const yearPhrase = known\.map/);
    expect(src).toMatch(/CAR 指数 &lt;5% 为低风险/);
    expect(src).not.toMatch(/可放心投稿/); // 7-03 ③: 承诺性话术红线, 保留数据不替读者拍板
    expect(src).toMatch(/建议谨慎评估或避开/);
  });
  it("结论以 jcarindex 风险等级为准 (低/中/高), 不自行重算", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/rank === "高"[\s\S]{0,40}?rank === "中"[\s\S]{0,40}?rank === "低"/);
  });
  it("表格: 只渲染有真值年份, 不再出'未公布'占位列 (7-03 截图事故修复)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(known\.length > 0\) \{/);
    expect(src).toMatch(/const headCells = known\.map/);
    // 表格渲染里不再有"未公布"兜底列（intro 的"暂未公布"措辞不算表格列）
    expect(src).not.toMatch(/`\$\{d\.carIndex\.toFixed\(2\)\}%` : `<span/);
  });
  it("CAR 数据点全空 → 整块隐藏 (7-03: 有风险等级也不再渲染空表)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(known\.length === 0\) return "";/);
  });
  it("保留问题文章数 + 来源标注", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/问题文章数/);
    expect(src).toMatch(/数据来源：jcarindex/);
  });
});
