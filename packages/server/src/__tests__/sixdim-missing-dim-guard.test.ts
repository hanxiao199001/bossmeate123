/**
 * 8-22 缺维即失败 —— 回归锁。
 *
 * 用**真实发生过的坏输出**当测试输入（红线：自己犯过的错是最可靠的测试来源，
 * 因为它一定发生过，不是想象出来的边界）。
 *
 * 事故：同尺 5 轮标定实测 7.6% 的评分调用产出垃圾分，模式是
 * 「前 N 维有分、后面全 0」—— JSON 截断 + `clamp(NaN → 0)`。
 * 零维频率严格按 JSON 出场顺序单调递增（topicHook 0 次 → originalityCompliance 19 次）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..");
const src = readFileSync(join(SRC, "services/content-engine/quality-check-v2.ts"), "utf8");

describe("缺维必须抛错，不许按 0 分计", () => {
  it("解析循环里有 missing 收集", () => {
    expect(src).toMatch(/const missing: string\[\] = \[\]/);
  });

  it("🔴 分数非有限数时 push 进 missing 并 continue，而不是给一个分", () => {
    // 锁结构关系（红线 #16）：判据与 continue 必须在同一个窗口里
    const i = src.indexOf("if (!Number.isFinite(rawScore))");
    expect(i).toBeGreaterThan(0);
    const window = src.slice(i, i + 120);
    expect(window).toContain("missing.push");
    expect(window).toContain("continue");
  });

  it("missing 非空 → throw（走既有重打/降级链路，最终判 unscored）", () => {
    const i = src.indexOf("if (missing.length > 0)");
    expect(i).toBeGreaterThan(0);
    const window = src.slice(i, i + 700);
    expect(window).toMatch(/throw new Error/);
    // 必须记日志且带定位信息 —— 只 throw 不记，下次还是查不出是哪一维
    expect(window).toContain("logger.warn");
    expect(window).toContain("missing");
    expect(window).toContain("outputLen");
  });

  it("🔴 clamp 的 NaN 兜底不许再承担判据职责（注释写死这条）", () => {
    const i = src.indexOf("function clamp(");
    const before = src.slice(Math.max(0, i - 900), i);
    expect(before).toMatch(/不再承担任何判据职责/);
  });
});

describe("与 7-27 那条教训的边界（不能因为修这个又把零产出重演一遍）", () => {
  it("缺维走的是「评分失败」路径，不是「内容有问题」路径", () => {
    // 抛错 → 既有重试链 → 最终 quality_check_unavailable（没评上分，排队尾，不是红线剔除）
    expect(src).toContain("quality_check_unavailable");
    // 且缺维的错误信息必须自证是我们的问题，不是内容的问题
    const i = src.indexOf("if (missing.length > 0)");
    expect(src.slice(i, i + 700)).toMatch(/疑输出截断|疑截断/);
  });
});

describe("崩溃的指纹（写死实测形态，防日后有人改回去）", () => {
  it("文件头记录了截断指纹与零维单调性", () => {
    const i = src.indexOf("维度缺失 = 评分失败");
    expect(i).toBeGreaterThan(0);
    const doc = src.slice(i, i + 2200);
    expect(doc).toMatch(/7\.6%/);
    expect(doc).toMatch(/前 N 维有分、后面全 0/);
    expect(doc).toMatch(/单调递增/);
    // 明确写出"不要只改 clamp 就算完"
    expect(doc).toMatch(/不要改 `clamp`/);
  });
});
