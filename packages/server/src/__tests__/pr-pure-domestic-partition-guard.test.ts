import { describe, it, expect } from "vitest";
import { isPureDomesticJournal } from "../services/skills/article-skill.js";

/**
 * 7-21 纯国内刊正文分区/IF 禁写约束的范围判定。
 *
 * 背景: 改动3 治好了国内刊标题编造, 但正文偶尔仍编分区(实测8篇里2篇: 人口研究"1区"/中国科学物理学"2区")。
 *   补正文侧禁写约束, 但**严格只对纯国内刊**(北大核心/CSSCI/CSCD 且不含 sci-core)。
 *   骑墙刊(含 sci-core)绝不能碰 —— 它们分区可能是 enrichment 有据的(backlog-C),
 *   6577b9a 全局禁写就是误伤了它们才被回滚。
 */
describe("isPureDomesticJournal — 纯国内刊禁写分区的范围判定", () => {
  it("纯北大核心 → 是纯国内刊(受约束)", () => {
    expect(isPureDomesticJournal(["pku-core"])).toBe(true);
  });

  it("北大核心+CSSCI → 是纯国内刊", () => {
    expect(isPureDomesticJournal(["pku-core", "cssci"])).toBe(true);
  });

  it("纯 CSCD → 是纯国内刊", () => {
    expect(isPureDomesticJournal(["cscd"])).toBe(true);
  });

  it("CSSCI 扩展版 → 是纯国内刊", () => {
    expect(isPureDomesticJournal(["cssci-ext"])).toBe(true);
  });

  it("三核心齐收 → 是纯国内刊", () => {
    expect(isPureDomesticJournal(["pku-core", "cssci", "cscd"])).toBe(true);
  });

  it("🚫 骑墙刊: 北大核心 + sci-core → **不是**纯国内刊(不受约束, 避免误伤 backlog-C)", () => {
    expect(isPureDomesticJournal(["pku-core", "cssci", "cscd", "sci-core"])).toBe(false);
  });

  it("🚫 骑墙刊: 纯 CSCD + sci-core → 不是纯国内刊", () => {
    expect(isPureDomesticJournal(["cscd", "sci-core"])).toBe(false);
  });

  it("🚫 骑墙刊: 地理科学进展的真实 catalogs → 不是纯国内刊(它 enrichment 有真分区)", () => {
    // 生产实例: 地理科学进展 catalogs = [pku-core, cssci, cscd, sci-core]
    expect(isPureDomesticJournal(["pku-core", "cssci", "cscd", "sci-core"])).toBe(false);
  });

  it("纯国际刊(只有 sci-core) → 不是纯国内刊", () => {
    expect(isPureDomesticJournal(["sci-core"])).toBe(false);
  });

  it("无核心标签(multi_source_verified 国际刊, catalogs 空) → 不是纯国内刊", () => {
    expect(isPureDomesticJournal([])).toBe(false);
    expect(isPureDomesticJournal(null)).toBe(false);
    expect(isPureDomesticJournal(undefined)).toBe(false);
  });
});
