/**
 * 5-20 PR #194 — 从 if_history 提取最新 IF 填 impact_factor. file-content regression.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #194: orchestrator 增量提取 impact_factor", () => {
  it("if_history tryExtract 后加 impact_factor tryExtract", async () => {
    const src = await readSrc("../services/journal-enricher/orchestrator.ts");
    expect(src).toMatch(/tryExtract\("impact_factor", "impactFactor"/);
    expect(src).toMatch(/最新年在前/);
    expect(src).toMatch(/realProvenance\.impactFactor = "letpub"/);
  });
});

describe("PR #194: backfill 脚本补存量", () => {
  it("backfill-if-from-history: latestIF + 只补空值不覆盖", async () => {
    const src = await readSrc("../scripts/backfill-if-from-history.ts");
    expect(src).toMatch(/function latestIF/);
    expect(src).toMatch(/isNull\(journals\.impactFactor\), isNotNull\(journals\.ifHistory\)/);
  });
  it("兼容 {data:[{year,if}]} / [{year,value}] 两种结构", async () => {
    const src = await readSrc("../scripts/backfill-if-from-history.ts");
    expect(src).toMatch(/row\.if \?\? row\.value/);
  });
});
