/**
 * PR #253 → PR-E 更新: 字幕字号/位置已配置化 (env.DVH_SUBTITLE_*).
 * 原断言 fontSize=28 / marginV=200 硬编码已废, 改读 env (默认值在 config/env.ts).
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
describe("PR-E: 字幕字号/位置配置化", () => {
  it("video-postprocess fontSize/marginV 读 env", async () => {
    const src = await readSrc("../services/digital-human/video-postprocess.ts");
    expect(src).toMatch(/fontSize: env\.DVH_SUBTITLE_FONT_SIZE/);
    expect(src).toMatch(/marginV: env\.DVH_SUBTITLE_MARGIN_V/);
    expect(src).not.toMatch(/fontSize: 42/);
  });
});
