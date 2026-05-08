/**
 * PR Q.10：公众号草稿排版 polish — URL 智能截断 + 深度分析章节字号 / 行距 / 段距 polish。
 */
import { describe, it, expect } from "vitest";

async function read(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.10: 长 URL 智能截断 + 深度分析章节排版", () => {
  it("shunshi 模板：长 URL（> 50 字符）显示「查看官网 →」+ href 不变", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/journal\.website\.length > 50.*查看官网/s);
    expect(src).toMatch(/<a href="\$\{safe\}".*\$\{anchorText\}<\/a>/);
  });

  it("renderDeepAnalysisSection 字号 14→13 + line-height 1.8→1.95", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/font-size:13px;line-height:1\.95/);
  });

  it("renderDeepAnalysisSection padding 14→18 / 16→20", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/padding:18px 20px/);
  });

  it("polished html 改写 <p> 加 12px 空白 + <li> 加 6px margin", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/<p\\b.*margin:0 0 12px 0/);
    expect(src).toMatch(/<li\\b.*margin:0 0 6px 0/);
  });
});
