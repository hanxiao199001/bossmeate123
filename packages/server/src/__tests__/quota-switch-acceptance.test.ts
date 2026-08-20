/**
 * v2 配额切换的**预注册验收判据**（8-20）。
 *
 * 🔴 这些数字写在**切换之前**。理由与红线 #18 同源：
 * 明早看到数字之后再定标准，人总能给任何结果编一个「这也合理」的解释。
 *
 * 判据来自影子实测（8-19 夜）：18 篇 / 12 学科 / education 4 / failed 0。
 */
import { describe, it, expect } from "vitest";
import { evaluateSwitch } from "../services/recommendation/auto-quota-v2.js";

const base = { educationSlots: 4, disciplineCount: 12, totalSlots: 18, failedArticles: 0 };

describe("① 通过线", () => {
  it("影子实测的那组数 → 通过", () => {
    const v = evaluateSwitch(base);
    expect(v.pass).toBe(true);
    expect(v.rollback).toBe(false);
  });

  it("容差内的浮动仍算通过（education 4±1、总量 18±2）", () => {
    for (const o of [
      { ...base, educationSlots: 3 },
      { ...base, educationSlots: 5 },
      { ...base, totalSlots: 16 },
      { ...base, totalSlots: 20 },
      { ...base, disciplineCount: 10 },
    ]) {
      expect(evaluateSwitch(o).pass, JSON.stringify(o)).toBe(true);
    }
  });

  it("容差外不算通过（但未必回滚）", () => {
    expect(evaluateSwitch({ ...base, educationSlots: 7 }).pass).toBe(false);
    expect(evaluateSwitch({ ...base, disciplineCount: 8 }).pass).toBe(false);
  });
});

describe("② 回滚线（任一命中即回滚）", () => {
  it("education > 10 → 回滚（新算法没起作用）", () => {
    const v = evaluateSwitch({ ...base, educationSlots: 24 });
    expect(v.rollback).toBe(true);
    expect(v.reasons.join()).toContain("没起作用");
  });

  it("总量 < 12 → 回滚（产量塌了）", () => {
    expect(evaluateSwitch({ ...base, totalSlots: 8 }).rollback).toBe(true);
  });

  it("出现任何 failed → 回滚（引入了新的失败）", () => {
    expect(evaluateSwitch({ ...base, failedArticles: 1 }).rollback).toBe(true);
  });

  /**
   * 🔴 回滚优先于通过：两条同时满足时必须回滚。
   * 否则「大部分指标好看」会盖过「引入了新失败」这种硬伤。
   */
  it("回滚线与通过线冲突时，回滚优先", () => {
    const v = evaluateSwitch({ ...base, failedArticles: 3 });
    expect(v.rollback).toBe(true);
    expect(v.pass).toBe(false);
  });
});

describe("③ 无数据 ≠ 产量塌了", () => {
  /**
   * 🔴 8-20 实测踩到：切换后 1 分钟跑判据，窗口取的是当晚（还没发生），
   * totalSlots=0 触发了「产量塌了 → 回滚」。
   * **判据把「还没有数据」和「产量塌了」判成了同一件事。**
   *
   * 照那个 rollback 执行，就会基于一个尚未发生的夜晚关掉刚上线的功能。
   * 这是红线 #18 的漏项：我写完判据没拿**空窗口**验过它。
   */
  it("空窗口 → noData，既不 pass 也不 rollback", () => {
    const v = evaluateSwitch({ educationSlots: 0, disciplineCount: 0, totalSlots: 0, failedArticles: 0 });
    expect(v.noData).toBe(true);
    expect(v.rollback).toBe(false);
    expect(v.pass).toBe(false);
    expect(v.reasons.join()).toContain("什么都别做");
  });

  it("有数据但产量低 → 才是真回滚", () => {
    const v = evaluateSwitch({ educationSlots: 2, disciplineCount: 3, totalSlots: 5, failedArticles: 0 });
    expect(v.noData).toBe(false);
    expect(v.rollback).toBe(true);
  });
});

describe("④ 判据不许被调用方软化", () => {
  /**
   * 阈值写死在函数里，不接受传参覆盖 —— 能被传参调整的判据等于没有判据。
   * 这条用签名锁：evaluateSwitch 只收观测值，不收阈值。
   */
  it("evaluateSwitch 只有一个参数（观测值），没有阈值入口", () => {
    expect(evaluateSwitch.length).toBe(1);
  });
});
