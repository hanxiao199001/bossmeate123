/**
 * 事实密度（P1-A，8-07）—— 测量与验收工具，**不是闸**。
 *
 * 锁三件:
 *   ① 判据复用(与 findBodyFabrication 同源), 不许分叉
 *   ② cited 只在 available 为真时才算 —— 否则"编得越多密度越高"
 *   ③ 匹配器行为冻结(discipline/publisher 的字面匹配偏弱是**已知偏差**,
 *      A2 验收前不许改, 否则 before/after 的尺子不一致)
 */
import { describe, it, expect } from "vitest";

const { computeFactDensity, factDensityMetadata } = await import("../services/content-engine/fact-density.js");

const RICH = {
  impactFactor: 3.2, partition: "Q1", reviewCycle: "8-12周",
  catalogs: ["sci"], discipline: "教育学", publisher: "某某出版社",
};
const SPARSE = { catalogs: ["cssci"], discipline: "教育学", publisher: "某某大学" };

describe("available: DB 有几条可写事实", () => {
  it("rich 刊 6 类全有", () => {
    expect(computeFactDensity("", RICH).factsAvailable).toBe(6);
  });

  it("sparse 刊只有目录/学科/出版社 3 类", () => {
    expect(computeFactDensity("", SPARSE).factsAvailable).toBe(3);
  });

  it("期刊为 null → 0, 不抛错", () => {
    expect(computeFactDensity("正文", null).factsAvailable).toBe(0);
    expect(computeFactDensity("正文", null).citeRatio).toBeNull();
  });

  it("citeRatio 在 available=0 时是 null(无米之炊, 比值没意义)", () => {
    expect(computeFactDensity("随便什么正文", {}).citeRatio).toBeNull();
  });
});

describe("cited: 正文用上了几条", () => {
  it("正文写了 IF 和分区 → 两类都算引用", () => {
    const d = computeFactDensity("本刊 IF 3.2，属于 Q1 期刊。", RICH);
    expect(d.detail.impactFactor.cited).toBe(true);
    expect(d.detail.partition.cited).toBe(true);
  });

  it("🔴 DB 没有却写了 → **不算引用**(那是编造, 归 findBodyFabrication 管)", () => {
    // sparse 刊 DB 无 IF, 正文却写 IF 5.0 —— 算成引用会让"编得越多密度越高"
    const d = computeFactDensity("本刊 IF 5.0，Q1 期刊。", SPARSE);
    expect(d.detail.impactFactor.available).toBe(false);
    expect(d.detail.impactFactor.cited).toBe(false);
    expect(d.detail.partition.cited).toBe(false);
    expect(d.factsCited).toBeLessThanOrEqual(d.factsAvailable);
  });

  it("cited 永远不超过 available(不变量)", () => {
    for (const [body, src] of [["IF 9.9 Q1 审稿3天 北大核心 教育学 某某大学", SPARSE], ["", RICH]] as const) {
      const d = computeFactDensity(body, src);
      expect(d.factsCited).toBeLessThanOrEqual(d.factsAvailable);
    }
  });

  it("审稿周期走 TITLE_DATA_CLAIM(与编造检测同一批正则)", () => {
    expect(computeFactDensity("审稿约 8 周。", RICH).detail.submissionFlow.cited).toBe(true);
  });

  it("SVG 里的数字不算正文引用(图表数据不是行文)", () => {
    const d = computeFactDensity(`<svg><text>IF 3.2</text></svg><p>正文没提指标。</p>`, RICH);
    expect(d.detail.impactFactor.cited).toBe(false);
  });

  it("正则带 g 不留 lastIndex 残留(连续调用结果稳定)", () => {
    const body = "IF 3.2";
    const a = computeFactDensity(body, RICH).detail.impactFactor.cited;
    const b = computeFactDensity(body, RICH).detail.impactFactor.cited;
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});

describe("🔒 匹配器冻结(A2 验收前不许改)", () => {
  it("discipline 走**字面包含** —— 同义表述漏计是已知偏差, 锁住现状", () => {
    // 「教育学」原样出现 → 算引用
    expect(computeFactDensity("本刊聚焦教育学研究。", SPARSE).detail.discipline.cited).toBe(true);
    // 「教育领域」是同义表述 → **当前不算**。这条断言是故意锁住偏差的:
    //   before/after 必须同一把尺子; 想修同义词匹配, 等 A2 验收完一个完整周期。
    expect(computeFactDensity("本刊聚焦教育领域研究。", SPARSE).detail.discipline.cited).toBe(false);
  });

  it("publisher 同样是字面包含", () => {
    expect(computeFactDensity("由某某大学主办。", SPARSE).detail.publisher.cited).toBe(true);
  });
});

describe("metadata 形态", () => {
  it("落库四个字段, 含逐类明细(排查时看得出哪条有数据却没写)", () => {
    const m = factDensityMetadata(computeFactDensity("IF 3.2", RICH));
    expect(m.factsAvailable).toBe(6);
    expect(typeof m.factsCited).toBe("number");
    expect(m.factsCiteRatio).not.toBeUndefined();
    expect(m.factsDetail).toBeTruthy();
  });
});
