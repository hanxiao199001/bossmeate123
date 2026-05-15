/**
 * PR #141 (5-15): 数字人前端按钮 wire 防回归。
 * web 无组件测试设施（无 testing-library），用文件内容回归检查 —
 * 同 q0-split-buttons.test.ts / pr141-content-type-video.test.ts 模式。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #141: 数字人前端按钮 wire", () => {
  it("RecommendationCard 含 [🎬 生成数字人视频] 按钮 + 4 模板 select + onGenerateDvh prop", async () => {
    const src = await readSrc("../../../../apps/web/src/components/RecommendationCard.tsx");
    expect(src).toMatch(/🎬 生成数字人视频/);
    expect(src).toMatch(/onGenerateDvh:\s*\(templateId: string\)\s*=>\s*void/);
    expect(src).toMatch(/DVH_TEMPLATES/);
    // 4 套模板齐全
    expect(src).toMatch(/A_academic/);
    expect(src).toMatch(/B_marketing/);
    expect(src).toMatch(/C_popular/);
    expect(src).toMatch(/E_industry/);
  });

  it("RecommendationFeedPage wire onGenerateDvh → POST /generate-dvh-video + toast", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/RecommendationFeedPage.tsx");
    expect(src).toMatch(/onGenerateDvh=/);
    expect(src).toMatch(/generate-dvh-video/);
    expect(src).toMatch(/toast\.success/);
  });

  it("ContentDetailPage 含数字人视频按钮 + select，调 generate-dvh-video", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    expect(src).toMatch(/🎬 生成数字人视频/);
    expect(src).toMatch(/generate-dvh-video/);
    expect(src).toMatch(/handleGenerateDvhVideo/);
  });

  it("ContentDetailPage 老 video_script 按钮已下线（无 generate-video 调用 / handleGenerateVideo）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    expect(src).not.toMatch(/handleGenerateVideo/);
    expect(src).not.toMatch(/\/generate-video["'`]/); // 老 POST /articles/:id/generate-video 已删
    expect(src).not.toMatch(/videoGenStatus/);
  });
});
