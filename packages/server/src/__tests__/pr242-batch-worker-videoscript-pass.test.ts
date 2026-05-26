/**
 * 5-23 PR #242 — batch-worker cherry-pick 白名单加 videoScript.
 * PR #241 输出该字段, 但 batch-worker 写 contents.metadata 时白名单没含, 导致 bridge 读不到.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const WORKER = "../services/batch/batch-worker.ts";

describe("PR #242: batch-worker videoScript 透传", () => {
  it("cherry-pick 白名单含 videoScript", async () => {
    const src = await readSrc(WORKER);
    expect(src).toMatch(/"hasWarnings", "validatorIssues", "qualityScore", "qualityPassed", "aiScore", "hardMetrics", "templateId", "videoScript"/);
  });
  it("PR #242 注释说明", async () => {
    const src = await readSrc(WORKER);
    expect(src).toMatch(/PR #242/);
    expect(src).toMatch(/bridge 读 metadata\.videoScript/);
  });
});
