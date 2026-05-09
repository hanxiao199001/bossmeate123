/**
 * PR Q.10.1：长段拆分 + 关键数字 <strong> 高亮 + prompt 强约束防回归。
 */
import { describe, it, expect } from "vitest";

async function read(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.10.1: prompt + 后处理 + strong 高亮", () => {
  it("template-prompt-injector NUMBER_CONSTRAINT 后含深度分析格式约束 + 正反例", async () => {
    const src = await read("../services/skills/template-prompt-injector.ts");
    expect(src).toMatch(/深度分析章节格式/);
    expect(src).toMatch(/每段 ≤ 80 字/);
    expect(src).toMatch(/<strong>2021 年/);
    expect(src).toMatch(/Q\.10\.1/);
  });

  it("renderDeepAnalysisSection 含长段拆分（PR Q.10.2 阈值 80/50 激进切段）", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/inner\.length <= 80/);
    expect(src).toMatch(/split\(\/\(\?<=\[。！？\]\)\//);
    expect(src).toMatch(/buf \+ s\)\.length > 50/);
  });

  it("renderDeepAnalysisSection 裸数字自动 <strong> 包裹", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/\\d\+\\\.\\d\{1,3\}.*\\d\+%.*\\d\{4\}\\s\*年/);
    expect(src).toMatch(/before.*<strong/);
  });

  it("renderDeepAnalysisSection strong 加 underline 高亮（PR Q.10.2 改 background → text-decoration-underline，wechat sanitize 兼容）", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/strong\\b.*\(\?\!\[\^>\]\*style=\)/);
    // PR Q.10.2: background:{{PRIMARY_BG}} → text-decoration:underline + color:{{PRIMARY}}
    expect(src).toMatch(/text-decoration:\s*underline/);
    expect(src).toMatch(/color:\{\{PRIMARY\}\}/);
  });
});
