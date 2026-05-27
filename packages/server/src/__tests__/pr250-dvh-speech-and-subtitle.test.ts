/**
 * 5-24 PR #250 — 语速 1.3 倍 + 字幕黄字黑边 (6 位 hex 重试).
 * PR #248 outline 8 位 RGBA 没生效, 改 6 位 + 黄字 (抖音爆款经典).
 * 默认语速过慢, speechRate=150 (~1.3x).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #250: 语速 + 字幕色", () => {
  it("audioInfo 加 speechRate=150", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/speechRate: 150/);
    expect(src).toMatch(/1\.3x|1\.3 倍/);
  });
  it("字幕改 6 位 hex 黄字黑边", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/color: "FFFF00"/);
    expect(src).toMatch(/outlineColor: "000000"/);
  });
  it("y 维持 1450 不动", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/y: 1450/);
  });
});
