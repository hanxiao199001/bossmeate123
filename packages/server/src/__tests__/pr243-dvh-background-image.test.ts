/**
 * 5-23 PR #243 — DVH submit 加 backgroundImageUrl 支持.
 * 视频默认黑底, SDK VideoInfo 字段 backgroundImageUrl 可传 OSS 图片 URL.
 *
 * 7-29 契约变更: 优先级链从两级扩到三级, 并抽成 resolveBackgroundUrl() 供两个 submit 分支共用。
 *   新契约: 单次指定(opts.backgroundUrl) > per-template(mapping.backgroundUrl) > env DVH_DEFAULT_BG_URL > undefined(黑底)
 *   哨兵 DVH_BG_NONE("none") 短路整条链 → undefined, 让运营能显式选"不用背景"。
 *   本文件断言随生产契约更新(红线 #12: 更新到新契约, 不为过测试改生产代码)。
 *   优先级链的行为断言见 dvh-background-selection.test.ts, 这里保留源码级契约断言(防有人把链改回两级/漏改音频分支)。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const MAPPING = "../services/digital-human/template-mapping.ts";
const SUBMIT = "../services/digital-human/submit-task.ts";

describe("PR #243 (7-29 扩展): DVH 背景图配置", () => {
  it("AvatarVoiceMapping 接口加 backgroundUrl?: string", async () => {
    const src = await readSrc(MAPPING);
    expect(src).toMatch(/backgroundUrl\?: string;/);
    expect(src).toMatch(/PR #243/);
  });
  it("submit-task: 优先级链抽成 resolveBackgroundUrl(单次 > per-template > env > undefined)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/export function resolveBackgroundUrl\(optUrl\?: string, mappingUrl\?: string\)/);
    expect(src).toMatch(/if \(optUrl === DVH_BG_NONE\) return undefined;/);
    expect(src).toMatch(/return optUrl \|\| mappingUrl \|\| process\.env\.DVH_DEFAULT_BG_URL \|\| undefined;/);
  });
  it("两个 submit 分支(文本驱动/音频驱动)都走同一条链, 不许只改一个", async () => {
    const src = await readSrc(SUBMIT);
    const uses = src.match(/const backgroundImageUrl = resolveBackgroundUrl\(opts\.backgroundUrl, mapping\.backgroundUrl\);/g) ?? [];
    expect(uses.length).toBe(2);
  });
  it("submit 前对背景 URL 做可达性预检(不可达拒绝提交, 不静默降级黑底)", async () => {
    const src = await readSrc(SUBMIT);
    const guards = src.match(/if \(backgroundImageUrl\) await assertBackgroundReachable\(backgroundImageUrl\);/g) ?? [];
    expect(guards.length).toBe(2); // 两个分支都要有
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
