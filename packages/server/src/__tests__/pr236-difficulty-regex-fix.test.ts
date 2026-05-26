/**
 * 5-23 PR #236 — 修 parseAcceptanceDifficulty regex 漏 "网友分享经验" 中介短语 bug.
 * 案例: PR #235 全量跑 1400 本 difficulty 0 命中, ablesci HTML 是 "录用比例 → 网友分享经验：→ 较易"
 *   三段结构, 原 regex 要求字段名后紧邻难度词, 漏过. 改非贪婪 [\s\S]{0,40}? 允许中介内容.
 *
 * 这个测试不读 source 字符串, 而是直接 import parser 测真值, 因为正则细节比 source 形态重要.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-ablesci-detail.ts";

describe("PR #236: parser regex 修复", () => {
  it("非贪婪 [\\s\\S]{0,40}? 中介 + 后视边界", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/\[\\s\\S\]\{0,40\}\?/);
    expect(src).toMatch(/\(\?=\[\\s,，。;；、\]\|\$\)/);
  });
  it("PR #236 注释说明 ablesci '录用比例 → 网友分享经验：→ 较易' 结构", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/录用比例 → 网友分享经验：→ 较易/);
    expect(src).toMatch(/PR #236/);
  });
  it("数字段 (例如 '约 50%') 不应误匹配", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/if \(\/\[0-9%\]\/\.test\(raw\)\) return null/);
  });
});
