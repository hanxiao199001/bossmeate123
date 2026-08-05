import { describe, it, expect } from "vitest";
import { readDeferred, deferredBadge } from "./deferred";

/**
 * 8-03: 内容列表要能把"失败"和"待重试"分开。
 * 这两个词在运营那里对应**两种完全不同的动作**: 一个要去找人, 一个什么都不用做。
 * 8-03 欠费那天列表里全是"失败", 运营以为这批内容废了 —— 其实原稿都在, 充值后系统自己会跑。
 */
describe("readDeferred", () => {
  it("认得后端写的 metadata.deferred", () => {
    const d = readDeferred({ deferred: { reason: "quota_exceeded", detail: "AI 服务账户欠费", retryCount: 2 } });
    expect(d).toMatchObject({ reason: "quota_exceeded", detail: "AI 服务账户欠费", retryCount: 2 });
  });

  it("也认接口直接给的 deferred 字段(今日驾驶舱走这条)", () => {
    expect(readDeferred({ reason: "service_down" })?.reason).toBe("service_down");
  });

  it("形状不对/没有标记一律当没有, 绝不抛", () => {
    expect(readDeferred(null)).toBeNull();
    expect(readDeferred({})).toBeNull();
    expect(readDeferred({ deferred: { reason: "content_error" } })).toBeNull(); // 内容问题不显示"待重试"
    expect(readDeferred("nope")).toBeNull();
  });
});

describe("deferredBadge", () => {
  it("还会自动跑的 → 琥珀色「待重试」, 提示里明确说不用管", () => {
    const b = deferredBadge({ reason: "quota_exceeded", detail: "AI 服务账户欠费" });
    expect(b.label).toBe("待重试");
    expect(b.title).toContain("自动重跑");
    expect(b.title).toContain("不用管");
    expect(b.cls).toContain("amber");
  });

  it("重试用尽的 → 红色「重试已停」, 这条才真要人", () => {
    const b = deferredBadge({ reason: "service_down", retryCount: 5, exhausted: true });
    expect(b.label).toBe("重试已停");
    expect(b.title).toContain("人工");
    expect(b.cls).toContain("red");
  });

  it("重试过几次要显示出来(运营看得到系统在干活)", () => {
    expect(deferredBadge({ reason: "service_down", retryCount: 3 }).title).toContain("已自动重试 3 次");
  });
});
