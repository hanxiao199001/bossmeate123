/**
 * PR-E — DVH 字幕/语速配置化. env.ts 含默认值 (字号默认 42→60).
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
describe("PR-E: env.ts DVH 字幕配置默认值", () => {
  it("env.ts 有 DVH_SUBTITLE_* + DVH_SPEECH_RATE 默认值, 字号默认 15", async () => {
    const src = await readSrc("../config/env.ts");
    // 7-02: 288坐标系下36实际240px巨大溢出 → 15(≈100px); MarginV 200(距底69%顶到中间) → 84(距底29%)
    expect(src).toMatch(/DVH_SUBTITLE_FONT_SIZE: z\.coerce\.number\(\)\.default\(15\)/);
    expect(src).toMatch(/DVH_SPEECH_RATE: z\.coerce\.number\(\)\.default\(50\)/);
    expect(src).toMatch(/DVH_SUBTITLE_MARGIN_V: z\.coerce\.number\(\)\.default\(84\)/);
    expect(src).toMatch(/DVH_SUBTITLE_BOLD: z\.coerce\.number\(\)\.default\(1\)/);
  });
});
