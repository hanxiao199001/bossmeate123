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

  it("ContentPage.tsx dropdown 含 video option（PR #138 e2e 落地 type=video）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentPage.tsx");
    expect(src).toMatch(/<option value="video">视频<\/option>/);
  });

  it("ContentPage.tsx TYPE_LABELS + TYPE_ICONS 含 video（行渲染 fallback 防误）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentPage.tsx");
    expect(src).toMatch(/video:\s*"视频"/);
    expect(src).toMatch(/video:\s*"🎥"/);
  });
});
