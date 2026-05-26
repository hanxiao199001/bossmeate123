/**
 * 5-23 PR #229 — 防 AI 凭训练记忆编造分区/TOP.
 * 案例: PLoS Pathogens 分区 DB 全空, AI 仍写"生物学1区TOP"(训练记忆). 加防护.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #229: 防分区编造", () => {
  it("casPartitionNew 空时也加入未公开字段 (原静默丢失)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/else unknownFields\.push\("新锐分区"\); \/\/ PR #229/);
  });
  it("硬规则 #1 扩展: 分区/TOP/大类学科明确入严禁清单", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/分区\(如"1区"\/"Q1"\/"医学1区TOP"\/"生物学1区TOP"\)/);
    expect(src).toMatch(/学科大类\(如"医学"\/"生物学"\/"工程技术"\)/);
  });
  it("新规则 #15 显式禁分区编造 (含'你知道也不能写')", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/15\. 【禁编造分区\/TOP】/);
    expect(src).toMatch(/即便你"知道"这本刊是几区,在我们 DB 没有的情况下也不能写/);
  });
});
