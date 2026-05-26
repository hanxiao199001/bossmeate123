/**
 * 5-23 PR #243 — DVH submit 加 backgroundImageUrl 支持.
 * 视频默认黑底, SDK VideoInfo 字段 backgroundImageUrl 可传 OSS 图片 URL.
 * 优先级: per-template (mapping.backgroundUrl) > env DVH_DEFAULT_BG_URL > undefined (DVH 默认黑底).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const MAPPING = "../services/digital-human/template-mapping.ts";
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #243: DVH 背景图配置", () => {
  it("AvatarVoiceMapping 接口加 backgroundUrl?: string", async () => {
    const src = await readSrc(MAPPING);
    expect(src).toMatch(/backgroundUrl\?: string;/);
    expect(src).toMatch(/PR #243/);
  });
  it("submit-task: per-template > env > undefined 优先级", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/const backgroundImageUrl = mapping\.backgroundUrl \|\| process\.env\.DVH_DEFAULT_BG_URL \|\| undefined/);
  });
  it("submit-task: VideoInfo 条件传 backgroundImageUrl (有才传)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/\.\.\.\(backgroundImageUrl \? \{ backgroundImageUrl \} : \{\}\)/);
  });
  it("有背景时记 debug 日志方便诊断", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/dvh\.submit\.with_bg/);
  });
});
