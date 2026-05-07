/**
 * PR Q.6.1：title 历史峰值检测正则 + migrate apc 补 + NUMBER_CONSTRAINT 反例 防回归。
 */
import { describe, it, expect } from "vitest";

// 复刻 article-skill.ts 的检测正则（5-8 D5 C 套违反案例）
const PEAK_REGEX = /从\s*\d+(\.\d+)?\s*[飙涨升]+\s*[到至]\s*\d+/;

describe("PR Q.6.1: title 历史峰值检测", () => {
  it("命中 3 种历史峰值表述（5-8 D5 C 套实测：IF从44飙升到98.4）", () => {
    expect(PEAK_REGEX.test("IF从44飙升到98.4，凭什么？审稿4-8周")).toBe(true);
    expect(PEAK_REGEX.test("IF 从 44 涨到 98.4")).toBe(true);
    expect(PEAK_REGEX.test("影响因子从 50 升至 98")).toBe(true);
  });
  it("健康 title 不命中（仅当前值 / 录用率 / 审稿周期）", () => {
    expect(PEAK_REGEX.test("IF 98.4 的医学顶刊审稿仅 4-8 周")).toBe(false);
    expect(PEAK_REGEX.test("录用率 5%，The Lancet 投稿指南")).toBe(false);
  });
});

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.6.1: hotfix 集成防回归", () => {
  it("article-skill.ts 含 LLM 重生 1 次逻辑（detect → reinforced + temperature 0.4）", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/Q\.6\.1.*title 历史峰值幻觉/);
    expect(src).toMatch(/peakMatch.*content\.match/);
    expect(src).toMatch(/重生约束/);
    expect(src).toMatch(/temperature: 0\.4/);
  });

  it("NUMBER_CONSTRAINT_SUFFIX 含 ❌ 反例 wording", async () => {
    const src = await readSrc("../services/skills/template-prompt-injector.ts");
    expect(src).toMatch(/标题反例/);
    expect(src).toMatch(/❌.*飙升到/);
    expect(src).toMatch(/✅.*仅当前值/);
  });

  it("migrate.ts 补 The Lancet apc_fee=5500", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/apc_fee = 5500/);
    expect(src).toMatch(/cd850ce5-d30e-489a-8f31-aac4ef18faa2/);
    expect(src).toMatch(/apc_fee IS NULL/);  // idempotent guard
  });
});
