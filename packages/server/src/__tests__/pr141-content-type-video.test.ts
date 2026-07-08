/**
 * PR #141.0：content GET /content?type=video filter 防回归。
 * Fix: routes/content.ts 的 type whitelist 漏 "video"，导致前端选「视频」筛选静默失效。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #141.0: content type filter 包含 video", () => {
  it("routes/content.ts whitelist 含 video（前端 dropdown 已有此选项）", async () => {
    const src = await readSrc("../routes/content.ts");
    expect(src).toMatch(/"article",\s*"video_script",\s*"video",\s*"reply"/);
  });

  // 7-08 死测试清理 (确死: 读已删文件): 删 2 个 ContentPage.tsx 前端 it (dropdown video option + TYPE_LABELS/TYPE_ICONS) —
  //   断言目标 apps/web/src/pages/ContentPage.tsx 已删 (/content 整页下线, 内容管理移至 ContentWorkbenchPage)。readSrc → ENOENT。
  //   video type 的后端保障 (routes/content.ts whitelist 含 video) 仍由上方第 1 个 it 验证, 活。前端 dropdown 已随页面下线, 无取代页可断言。
});
