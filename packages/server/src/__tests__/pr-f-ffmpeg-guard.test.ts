/**
 * PR-F — ffmpeg/下载 超时护栏 file-content 回归.
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
describe("PR-F: ffmpeg 超时护栏", () => {
  it("runFFmpeg 超时 SIGKILL", async () => {
    const src = await readSrc("../services/digital-human/video-postprocess.ts");
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*proc\.kill\("SIGKILL"\)/);
    expect(src).toMatch(/env\.DVH_FFMPEG_TIMEOUT_MS/);
  });
  it("downloadToFile 超时 AbortController + 大小上限", async () => {
    const src = await readSrc("../services/digital-human/video-postprocess.ts");
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/controller\.abort\(\)/);
    expect(src).toMatch(/文件过大/);
    expect(src).toMatch(/env\.DVH_DOWNLOAD_MAX_MB/);
  });
  it("env.ts 有护栏默认值", async () => {
    const src = await readSrc("../config/env.ts");
    expect(src).toMatch(/DVH_FFMPEG_TIMEOUT_MS: z\.coerce\.number\(\)\.default\(300000\)/);
    expect(src).toMatch(/DVH_DOWNLOAD_MAX_MB: z\.coerce\.number\(\)\.default\(600\)/);
  });
});
