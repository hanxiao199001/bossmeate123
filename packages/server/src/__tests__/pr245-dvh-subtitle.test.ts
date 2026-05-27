/**
 * 5-24 PR #245 — DVH 视频开启字幕 (subtitleEmbedded=true).
 * 抖音/视频号竖屏视频, 字幕条对完播率影响很大 (无声场景占抖音 50%+).
 * V1 用 SDK 默认样式; 不满意后续 PR #246 加 subtitleStyle 调.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #245: 字幕嵌入", () => {
  it("subtitleEmbedded 改为 true", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/subtitleEmbedded: true/);
    expect(src).not.toMatch(/subtitleEmbedded: false/);
  });
  it("PR #245 注释说明", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/PR #245/);
    expect(src).toMatch(/字幕条嵌入视频/);
  });
});
