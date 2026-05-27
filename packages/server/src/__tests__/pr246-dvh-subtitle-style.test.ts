/**
 * 5-24 PR #246 — DVH 字幕样式调整.
 * 反馈: 默认字幕黑色 / 字号小 / 位置太靠下被抖音 UI 遮挡. 改白字黑描边 + 字号 64 + y=1500.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #246: 字幕样式", () => {
  it("subtitleStyle 配置完整 (color/outline/size/y)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/subtitleStyle: new \$avatar20220130\.SubmitTextTo2DAvatarVideoTaskRequestVideoInfoSubtitleStyle/);
    expect(src).toMatch(/color: "#FFFFFF"/);
    expect(src).toMatch(/outlineColor: "#000000"/);
    expect(src).toMatch(/size: 64/);
    expect(src).toMatch(/y: 1500/);
  });
  it("PR #246 注释解释 4 个调整理由", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/PR #246/);
    expect(src).toMatch(/白字黑描边/);
    expect(src).toMatch(/不贴底边/);
  });
});
