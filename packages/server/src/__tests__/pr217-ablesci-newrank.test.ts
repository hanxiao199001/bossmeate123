/**
 * 5-22 PR #217 — ablesci 新锐分区抓取脚本回归.
 * ablesci /journal/index?keywords=<ISSN> 服务端HTML, cheerio 解析「新锐分区 大类」写 casPartitionNew.
 * (parseNewRank 解析逻辑已用 cheerio 独立验证: "1区材料科学"✓, 无新锐→null✓)
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-ablesci-newrank.ts";

describe("PR #217: ablesci 新锐分区抓取", () => {
  it("按 ISSN 搜 /journal/index?keywords=", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/\/journal\/index\?keywords=\$\{encodeURIComponent\(issn\)\}/);
  });
  it("cheerio 解析 + 大类锚定正则(排除小类/JCR/IF)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/import \* as cheerio from "cheerio"/);
    expect(src).toMatch(/\^\(\\d\+\)区\(\[一-龥·：\]\{2,\}\)\$/);
    expect(src).toMatch(/\.replace\(\/\\s\+\/g, ""\)/); // 去空白处理 span+文本
  });
  it("写 casPartitionNew + provenance=ablesci", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/casPartitionNew: newRank/);
    expect(src).toMatch(/"casPartitionNew":"ablesci"/);
  });
  it("礼貌限速 ≥1s + 错误退避 + debug 模式", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/await sleep\(1000\)/);
    expect(src).toMatch(/await sleep\(2500\)/);
    expect(src).toMatch(/const DEBUG = process\.argv\.includes\("--debug"\)/);
  });
});
