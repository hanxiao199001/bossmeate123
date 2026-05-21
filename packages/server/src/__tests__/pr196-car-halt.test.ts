/**
 * 5-21 PR #196 — CAR 止血. file-content regression.
 *   CAR 来自 openalex-extractor cn/total 自算, 与 jcarindex 权威值差别大, 误导投稿决策. 暂关显示等接 jcarindex.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const T = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #196: CAR 止血", () => {
  it("renderCarHistoryBlock 暂关 (return 空)", async () => {
    const src = await readSrc(T);
    const fn = src.slice(src.indexOf("function renderCarHistoryBlock"), src.indexOf("function renderCarHistoryBlock") + 400);
    expect(fn).toMatch(/CAR 止血/);
    expect(fn).toMatch(/return "";/);
  });
  it("renderCarRiskAnalysis 暂关 (return 空)", async () => {
    const src = await readSrc(T);
    const fn = src.slice(src.indexOf("function renderCarRiskAnalysis"), src.indexOf("function renderCarRiskAnalysis") + 250);
    expect(fn).toMatch(/CAR 止血/);
    expect(fn).toMatch(/return "";/);
  });
});
