/**
 * `evaluated` 是**运行次数**，不是内容篇数（8-16）。
 *
 * 实测：本周 evaluated=841，同期出稿 191 篇 —— 差 4.4 倍，
 * 因为 draft-distributor 每天重扫存量草稿（163 篇挂 needs_review，天天过一遍闸）。
 * 任何把它当"篇数"读的文案都会把证据强度夸大 4 倍多。
 */
import { describe, it, expect } from "vitest";
import { judge, type CheckerStats } from "../services/ops/checker-ledger.js";

const stat = (o: Partial<CheckerStats> = {}): CheckerStats => ({
  checkerId: "z",
  evaluated: 841,
  hits: 0,
  confirmedTrue: 0,
  confirmedFalse: 0,
  confirmedMiss: 0,
  adjudicated: 0,
  hitRate: 0,
  ...o,
});

describe("零命中文案不许把「次」说成「篇」", () => {
  it("文案写「次」，且点明存量重扫", () => {
    const m = judge(stat()).message;
    expect(m).toContain("次");
    expect(m).toContain("重扫");
    expect(m).toContain("不等于内容篇数");
  });

  /**
   * 🔴 这条是本文件的要害：不许出现「N 篇」这种把运行次数说成内容量的写法。
   * 一旦这么写，读者会以为 841 篇内容都被验过是干净的，
   * 而实际是 191 篇被扫了 4.4 遍 —— 数字不假，读出来的意思是假的。
   */
  it("不出现「841 篇」式表述", () => {
    const m = judge(stat()).message;
    expect(m).not.toMatch(/\d+\s*篇/);
  });

  it("零命中仍然不给动作（安全闸本就该安静）", () => {
    expect(judge(stat()).action).toBeNull();
  });
});
