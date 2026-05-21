/**
 * 5-20 PR #195 — 分区徽章 fallback JCR zone. file-content regression.
 *   根因: renderJcrQuartileBlock 只看 journal.partition(中科院,多NULL), 没用 enrich 补的 jcrFull.jifSubjects[].zone.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const T = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #195: 分区徽章 fallback JCR zone", () => {
  it("partition 空时从 jcrFull.jifSubjects 取 zone", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/const raw = \(journal as \{ jcrFull\?: unknown \}\)\.jcrFull/);
    expect(src).toMatch(/raw\.jifSubjects as Array<\{ zone\?: string \}>/);
  });
  it("取最优 zone (Q1<Q2 排序)", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/zones\.sort\(\)\[0\]\.toUpperCase\(\)/);
  });
  it("仍用 isJcrFull type guard 校验", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/if \(isJcrFull\(raw\) && Array\.isArray\(raw\.jifSubjects\)\)/);
  });
});
