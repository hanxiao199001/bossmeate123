/**
 * 5-22 PR #205 — 版式差异化: 编辑型板块簇按期刊种子确定性重排.
 * 同一刊顺序稳定可复现, 不同刊顺序不同 → 多篇文章不雷同. 核心可信块(题图/IF/JCR)不动.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #205: 编辑型板块簇确定性重排", () => {
  it("有 journalLayoutSeed + seededOrder helper", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function journalLayoutSeed\(journal: JournalInfo\): number/);
    expect(src).toMatch(/function seededOrder<T>\(items: T\[\], seed: number\): T\[\]/);
  });
  it("seededOrder 用确定性 LCG (非 Math.random)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/s = \(s \* 1103515245 \+ 12345\) & 0x7fffffff/);
    // 重排逻辑里不能用 Math.random (那会破坏可复现)
    const fn = src.slice(src.indexOf("function seededOrder"), src.indexOf("function seededOrder") + 400);
    expect(fn).not.toMatch(/Math\.random/);
  });
  it("种子取自 ISSN/刊名 (稳定)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/journal\.issn \|\| journal\.nameEn \|\| journal\.name/);
  });
  it("编辑型板块簇走 seededOrder, 核心块不在簇内", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/const editorialCluster = seededOrder\(\[/);
    expect(src).toMatch(/for \(const blk of editorialCluster\) sections\.push\(blk\)/);
    // 簇内只含 5 个次级块, 题图/IF/JCR 不在内
    const cluster = src.slice(src.indexOf("const editorialCluster = seededOrder(["), src.indexOf("], journalLayoutSeed(journal));"));
    expect(cluster).toMatch(/renderAdvantagesBlock/);
    expect(cluster).toMatch(/renderPeerComparisonBlock/);
    expect(cluster).not.toMatch(/renderHeroBlock|renderImpactFactorBlock|renderJcrFullPanel/);
  });
});
