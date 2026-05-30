/**
 * PR #250 → PR-E 更新: 语速已配置化 (env.DVH_SPEECH_RATE).
 * 原断言 speechRate=150 / DVH 内嵌字幕色/y 均已废 (PR #259 改 50; PR #252 改 ffmpeg 后处理).
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
describe("PR-E: 语速配置化", () => {
  it("submit-task speechRate 读 env.DVH_SPEECH_RATE", async () => {
    const src = await readSrc("../services/digital-human/submit-task.ts");
    expect(src).toMatch(/speechRate: env\.DVH_SPEECH_RATE/);
    expect(src).toMatch(/import \{ env \} from "\.\.\/\.\.\/config\/env\.js"/);
  });
});
