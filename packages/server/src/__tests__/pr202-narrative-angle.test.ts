/**
 * 5-22 PR #202 — AI 正文结构多样化: 引入数据驱动的"叙事主线", 破除每篇同骨架的公式感.
 * 主线候选按"该刊真有什么数据"动态启用 (诚实, 不为多样性编故事), 再随机选一条注入 prompt.
 * 同时去掉模板里"（AI 综合分析）"标签 (暴露机器味).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #202: 叙事主线 (article angle)", () => {
  it("有 5 类候选主线", async () => {
    const src = await readSrc(ARTICLE);
    for (const k of ["趋势主线", "性价比主线", "避坑主线", "定位主线", "盘点主线"]) {
      expect(src).toContain(k);
    }
  });
  it("主线候选数据驱动 (按真实字段 gating)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/Array\.isArray\(ifHist\) && ifHist\.length >= 3/); // 趋势主线需 IF 历史
    expect(src).toMatch(/journal\.isWarningList \|\|/);                     // 避坑主线需预警/自引
    expect(src).toMatch(/angleCandidates\.push\(\{ key: "盘点主线"/);        // 兜底主线
  });
  it("随机选一条主线注入 prompt", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/const articleAngle = angleCandidates\[Math\.floor\(Math\.random\(\)/);
    expect(src).toMatch(/\$\{angleHint\}/);
    expect(src).toMatch(/【本篇叙事主线】/);
  });
  it("主线不破坏数据真实性 (显式约束)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/不改变数据真实性; 仍严禁编造未提供的数字/);
  });
});

describe("PR #202: 去 AI 感标签", () => {
  it("投稿建议标题不再带（AI 综合分析）", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).not.toMatch(/💡 投稿建议（AI 综合分析）/);
    expect(src).toMatch(/renderDeepAnalysisSection\("💡 投稿建议", ai\.submissionAdvice\)/);
  });
});
