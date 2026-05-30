/**
 * PR-E — DVH 字幕/语速配置化. env.ts 含默认值 (字号默认 42→60).
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
describe("PR-E: env.ts DVH 字幕配置默认值", () => {
  it("env.ts 有 DVH_SUBTITLE_* + DVH_SPEECH_RATE 默认值, 字号默认 60", async () => {
    const src = await readSrc("../config/env.ts");
    expect(src).toMatch(/DVH_SUBTITLE_FONT_SIZE: z\.coerce\.number\(\)\.default\(60\)/);
    expect(src).toMatch(/DVH_SPEECH_RATE: z\.coerce\.number\(\)\.default\(50\)/);
    expect(src).toMatch(/DVH_SUBTITLE_MARGIN_V: z\.coerce\.number\(\)\.default\(200\)/);
    expect(src).toMatch(/DVH_SUBTITLE_BOLD: z\.coerce\.number\(\)\.default\(1\)/);
  });
});
