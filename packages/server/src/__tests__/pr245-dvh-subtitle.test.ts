/**
 * PR #245→#252 — DVH 内嵌字幕已关闭 (subtitleEmbedded=false).
 * PR #245 曾开启内嵌字幕; PR #251 试 6 种颜色格式均不可控 → PR #252 关闭内嵌字幕,
 * 改由 buildSrtFromText 自生成后 burn-in。本测试改为回归护栏: 确认内嵌字幕保持关闭。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #245→#252: 内嵌字幕已关闭", () => {
  it("subtitleEmbedded 为 false (PR #252 关闭, 阿里云颜色不可控)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/subtitleEmbedded: false/);
    expect(src).not.toMatch(/subtitleEmbedded: true/);
  });
  it("PR #252 关闭原因注释在", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/PR #252/);
    expect(src).toMatch(/关闭 DVH 内嵌字幕/);
  });
});
