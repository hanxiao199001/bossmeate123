/**
 * 「contents.body 永远不指向占位/测试素材」—— 不变式守卫（8-13）。
 *
 * 事故：DVH 失败退占位样片，内容工坊里躺着 10 条「标题是真实期刊、片子是固定占位样片」
 * 的记录（片中还烧着 IF6.2 与无关期刊封面）。降级分支已删，这道闸守住不再复发。
 *
 * 自校验型判据：素材路径是我们自己定的，命中即矛盾 —— 不需要外部信息、不需要人看片。
 */
import { describe, it, expect } from "vitest";

const { checkOutputHealth, PLACEHOLDER_ASSET_MARKERS } = await import("../services/publisher/output-health.js");

const has = (r: { codes: string[] }) => r.codes.includes("placeholder_asset_in_body");

describe("占位素材命中", () => {
  it.each([
    "https://bossmate-media.oss-cn-beijing.aliyuncs.com/dvh-fixtures/placeholder-3.mp4",
    "https://x.com/dvh-fixtures/placeholder-1.mp4",
    "任意正文里嵌了 /placeholder-2.mp4 也算",
  ])("body=「%s」→ 命中", (body) => {
    expect(has(checkOutputHealth({ title: "评职称就缺这篇北大核心", body, type: "video" }))).toBe(true);
  });

  it("标题里出现也算（有人把 URL 写进标题）", () => {
    expect(has(checkOutputHealth({ title: "x dvh-fixtures/placeholder-1.mp4", body: "正文", type: "article" }))).toBe(true);
  });

  it("命中详情要说清「这不是真产物」——运营看的是这句话", () => {
    const r = checkOutputHealth({ title: "t", body: "https://x/dvh-fixtures/placeholder-3.mp4", type: "video" });
    const issue = r.issues.find((i) => i.code === "placeholder_asset_in_body");
    expect(issue?.detail).toContain("不是真产物");
  });
});

describe("防误伤：真产物不许命中", () => {
  it.each([
    "https://bossmate-media.oss-cn-beijing.aliyuncs.com/dvh-videos/558d962f-c8c7.mp4",
    "https://bossmate-media.oss-cn-beijing.aliyuncs.com/dvh-backgrounds/1785480679452.png",
    "<p>正常图文正文，讲的是占位符与模板的区别。</p>",
  ])("body=「%s」→ 不命中", (body) => {
    expect(has(checkOutputHealth({ title: "正常标题内容够长", body, type: "video" }))).toBe(false);
  });

  it("空 body 不炸", () => {
    expect(() => checkOutputHealth({ title: "t", body: null, type: "video" })).not.toThrow();
  });
});

describe("标记表本身", () => {
  it("三个特征都在（改这张表等于改不变式，应当是显式动作）", () => {
    expect([...PLACEHOLDER_ASSET_MARKERS]).toEqual(["dvh-fixtures/", "/placeholder-", "mock-fixture"]);
  });
});
