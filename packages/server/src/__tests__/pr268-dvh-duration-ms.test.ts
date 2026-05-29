/**
 * 5-29 PR #268 — DVH 时长单位修正.
 * 阿里云 videoDuration 实测是毫秒 (0:39 视频返回 39040), 原 query-task *1000 导致前端显示 39040s.
 * file-content 回归: 确保不再 *1000.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #268: DVH videoDuration 当毫秒用", () => {
  it("query-task durationMs 直接用 videoDuration, 不再 *1000", async () => {
    const src = await readSrc("../services/digital-human/query-task.ts");
    expect(src).toMatch(/durationMs: r\.videoDuration \?\? 0,/);
    expect(src).not.toMatch(/durationMs: \(r\.videoDuration \?\? 0\) \* 1000/);
  });
});
