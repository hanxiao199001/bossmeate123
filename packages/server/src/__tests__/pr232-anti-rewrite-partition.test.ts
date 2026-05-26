/**
 * 5-23 PR #232 — 防 AI 改写 DB 分区真值 (3区→2区 bug).
 * 案例: Advanced Materials Interfaces DB cas_partition_new='3区材料科学' (ablesci真值),
 *   AI 写成"材料科学2区"——既改数字(3→2)又改顺序("X区Y学科"→"Y学科X区").
 * PR #229 只防 NULL 时编造, 这里防"有值时改写".
 * 策略: knownFields 加 [必须原文搬运] 标记 + 硬规则 #1 + #16 显式禁止改字/改序/简化.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #232: 防分区真值改写", () => {
  it("knownFields 分区字段加 [必须原文搬运] 标记", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/分区 \[必须原文搬运, 不得改字\/改顺序\/简化\]/);
    expect(src).toMatch(/新锐分区 \[必须原文搬运, 不得改字\/改顺序\/简化\]/);
  });
  it("新硬规则 #16 显式禁'X区/学科'改字/改顺序/简化", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/16\. 【DB 真值原文搬运】\(PR #232\)/);
    expect(src).toMatch(/严禁写成 "2区" \/ "1区"/);
    expect(src).toMatch(/严禁写成 "材料科学3区" \/ "材料科学2区"/);
  });
  it("硬规则 #1 末尾追加 PR #232 强约束", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/\*\*\(PR #232\)\*\* 当 ##已知期刊数据## 已给出"分区"\/"新锐分区"字段时/);
    expect(src).toMatch(/必须\*\*逐字原文搬运\*\*/);
  });
});
