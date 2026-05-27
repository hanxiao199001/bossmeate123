/**
 * 5-24 PR #248 — 字幕黑字白边 + y 下移到 1450.
 * 反馈: PR #246 #FFFFFF/#000000 阿里云不认; PR #247 删了 color 后默认黑字小号在浅色背景发灰看不清.
 * 抖音爆款黑字白边 (深色/浅色背景都清晰). 试 8 位 RGBA hex 不带 # 格式.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #248: 字幕黑字白边 + y=1450", () => {
  it("color/outlineColor 用 8 位 RGBA hex (不带 #)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/color: "000000FF"/);
    expect(src).toMatch(/outlineColor: "FFFFFFFF"/);
  });
  it("y 下移到 1450 (屏幕 75%)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/y: 1450/);
  });
});
