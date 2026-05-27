/**
 * 5-24 PR #253 — 字幕字号 18→28 + marginV 80→200.
 * 反馈: 1080×1920 视频里 size=18 视觉太小, marginV=80 距底太近.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const POSTPROCESS = "../services/digital-human/video-postprocess.ts";

describe("PR #253: 字号 + 位置调整", () => {
  it("fontSize 改为 28", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/fontSize: 28/);
    expect(src).not.toMatch(/fontSize: 18/);
  });
  it("marginV 改为 200", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/marginV: 200/);
    expect(src).not.toMatch(/marginV: 80,/);
  });
  it("PR #253 注释解释 1080p 抖音爆款经验", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/PR #253/);
    expect(src).toMatch(/1080p 爆款常用尺寸/);
  });
});
