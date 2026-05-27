/**
 * 5-24 PR #247 — 字幕 y 上移到 1300.
 * PR #246 y=1500 仍被画面底边裁. 阿里云 y 是字幕顶部坐标, 加字幕高度 + padding 接近 1600+,
 * 1920 视频高已裁. 改 y=1300 确保完整可见.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #247: 字幕位置上移", () => {
  it("y 改为 1300", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/y: 1300/);
    expect(src).not.toMatch(/y: 1500,?\s*$/m);
  });
  it("PR #247 注释解释 y=1500 裁掉问题", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/PR #247/);
    expect(src).toMatch(/字幕被画面底边裁掉一半/);
  });
});
