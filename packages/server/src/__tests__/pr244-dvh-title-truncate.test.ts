/**
 * 5-23 PR #244 — DVH submit title 截到 ≤ 60 字, 防阿里云 64 字限.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #244: title 长度限制", () => {
  it("safeTitle 用 slice(0, 60) 截断", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/const safeTitle = \(\(opts\.title \|\| `BossMate DVH \$\{opts\.templateId\}`\) as string\)\.slice\(0, 60\)/);
  });
  it("req.title 用 safeTitle (不再直接用 opts.title)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/title: safeTitle,/);
  });
  it("PR #244 注释说明 64 字限制 + 4 字 buffer", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/PR #244/);
    expect(src).toMatch(/限 64 字/);
  });
});
