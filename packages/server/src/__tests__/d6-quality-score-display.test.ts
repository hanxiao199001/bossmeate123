/**
 * D6 sprint B：ContentDetailPage aiScore + hardMetrics 4 维度小指标显示防回归。
 */
import { describe, it, expect } from "vitest";

async function read(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("D6 sprint B: aiScore + hardMetrics 浮窗", () => {
  it("ContentDetailPage 含 aiScore badge 三档颜色（85+ 绿 / 70-84 蓝 / <70 橙）", async () => {
    const src = await read("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    expect(src).toContain('content.metadata?.aiScore === "number"');
    expect(src).toContain("AI {Math.round(content.metadata.aiScore as number)}/100");
    expect(src).toMatch(/bg-green-100[\s\S]*bg-blue-100[\s\S]*bg-orange-100/);
  });

  it("hardMetrics 4 维度（wordDeviationScore / paragraphScore / keyPointScore）", async () => {
    const src = await read("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    expect(src).toMatch(/wordDeviationScore/);
    expect(src).toMatch(/paragraphScore/);
    expect(src).toMatch(/keyPointScore/);
  });
});
