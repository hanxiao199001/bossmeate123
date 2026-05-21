/**
 * 5-21 PR #197 — 以 LetPub(WOS核心) 为准, 剔除 OpenAlex 不准数据. file-content regression.
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #197: 推荐池只推 LetPub WOS 数据", () => {
  it("recommender sciWhere 去掉 OpenAlex 近似 IF, 只认 wosLevel", async () => {
    const src = await readSrc("../services/recommendation/journal-recommender.ts");
    expect(src).toMatch(/wosLevel' ILIKE '%ESCI%/);
    expect(src).toMatch(/wosLevel' ILIKE '%AHCI%/);
    // sciWhere 块内不再有 impactFactor IS NOT NULL
    const block = src.slice(src.indexOf("const sciWhere"), src.indexOf("const selectCols"));
    expect(block).not.toMatch(/impactFactor\} IS NOT NULL/);
  });
});
describe("PR #197: IF 以 LetPub 为准", () => {
  it("backfill-if 覆盖所有有 if_history 的 (不只补 NULL)", async () => {
    const src = await readSrc("../scripts/backfill-if-from-history.ts");
    expect(src).toMatch(/\.where\(isNotNull\(journals\.ifHistory\)\)/);
    expect(src).not.toMatch(/isNull\(journals\.impactFactor\)/);
  });
});
