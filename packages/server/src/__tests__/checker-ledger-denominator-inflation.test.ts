/**
 * 三条自动判定规则对「分母膨胀」是否免疫（8-16 实测，非推理）。
 *
 * 背景：`evaluated` 是**运行次数**。draft-distributor 每天重扫存量草稿，
 * 8-16 实测 evaluated=841 而同期出稿仅 191 篇 —— 重扫系数 k≈4.4。
 *
 * 结论先写在这里，逐条有用例锁死：
 *   ① 降级规则   —— 分母无关 ✓，但**分子同样被重扫放大**，不等于免疫
 *   ② 常数检测   —— **不免疫**：对"只在存量上恒真"的闸，重扫把比率推向 1.0
 *   ③ 未来按率判定 —— 一律用覆盖内容数做分母（规则区已立注释）
 */
import { describe, it, expect } from "vitest";
import { judge, CONSTANT_RATE, MIN_HITS_FOR_VERDICT, type CheckerStats } from "../services/ops/checker-ledger.js";

const stat = (o: Partial<CheckerStats>): CheckerStats => {
  const base = { checkerId: "x", evaluated: 0, hits: 0, confirmedTrue: 0, confirmedFalse: 0, confirmedMiss: 0, ...o };
  return {
    ...base,
    adjudicated: base.confirmedTrue + base.confirmedFalse,
    hitRate: base.evaluated > 0 ? base.hits / base.evaluated : null,
  } as CheckerStats;
};

/** 8-16 生产实况：163 篇存量草稿每天重扫，当日新出稿 28 篇 */
const BACKLOG = 163;
const NEW = 28;
const K = 4; // 重扫轮数

describe("① 降级规则：分母无关 ✓，但分子会被重扫放大", () => {
  it("同样的 hits，evaluated 涨 10 倍不改变判定 —— 确实与分母无关", () => {
    const a = judge(stat({ evaluated: 100, hits: 30, confirmedFalse: 12 }));
    const b = judge(stat({ evaluated: 1000, hits: 30, confirmedFalse: 12 }));
    expect(a.level).toBe("suggest");
    expect(b.level).toBe("suggest");
    expect(b.action).toBe(a.action);
  });

  /**
   * 🔴 但「分母无关」不等于「重扫免疫」：hits 本身也是重扫出来的。
   * 5 篇不同的内容被扫 4 遍 = 20 条命中，正好跨过 MIN_HITS_FOR_VERDICT，
   * 于是「累计报 20 条真阳性 0」这句话，实情是「报了 5 篇，每篇报了 4 次」。
   */
  it("5 篇 × 4 轮重扫 = 20 hits，跨过阈值 —— 门槛的含义被重扫改写了", () => {
    const distinct = 5;
    const v = judge(stat({ evaluated: distinct * K * 3, hits: distinct * K, confirmedFalse: 10 }));
    expect(distinct * K).toBeGreaterThanOrEqual(MIN_HITS_FOR_VERDICT);
    expect(v.level).toBe("suggest");
    expect(v.message).toContain("20");
    // 而按去重内容数，它只报了 5 篇，远不到 20 的门槛
    expect(distinct).toBeLessThan(MIN_HITS_FOR_VERDICT);
  });
});

describe("② 常数检测：真恒真闸免疫，只在存量上恒真的闸不免疫", () => {
  it("真恒真闸（每次运行都报）—— 重扫多少轮，比率都是 1.0", () => {
    for (const k of [1, 4, 20]) {
      const ev = (BACKLOG + NEW) * k;
      const v = judge(stat({ evaluated: ev, hits: ev }));
      expect(v.level).toBe("warn");
      expect(v.message).toContain("零判别力");
    }
  });

  /**
   * 🔴 反例：只在**存量草稿**上恒真、对新内容不报的闸。
   *
   *   按运行次数：163×4 / (163×4 + 28) = 95.9% → 触发「零判别力」
   *   按覆盖篇数：163 / 191                  = 85.3% → 不该触发
   *
   * 重扫把它推过了 95% 线。方向是**更敏感**（有效阈值从 95% 掉到约 85%），
   * 不是失效 —— 但判定确实被分母膨胀改变了，所以这条规则**不免疫**。
   */
  it("只在存量上恒真的闸：按次数 95.9% 触发，按篇数 85.3% 不该触发", () => {
    const evaluated = BACKLOG * K + NEW;
    const hits = BACKLOG * K;
    const byRuns = hits / evaluated;
    const byContents = BACKLOG / (BACKLOG + NEW);

    expect(byRuns).toBeGreaterThan(CONSTANT_RATE);
    expect(byContents).toBeLessThan(CONSTANT_RATE);
    expect(judge(stat({ evaluated, hits })).level).toBe("warn");
  });

  it("重扫轮数越多越容易触发 —— 这就是「不免疫」的定量形态", () => {
    const rate = (k: number) => (BACKLOG * k) / (BACKLOG * k + NEW);
    expect(rate(1)).toBeLessThan(CONSTANT_RATE);   // 不重扫时不触发
    expect(rate(4)).toBeGreaterThan(CONSTANT_RATE); // 重扫 4 轮后触发
  });
});

describe("③ 台账未成熟：只看已裁决数，与分母无关", () => {
  it("evaluated 从 100 涨到 10000，未成熟判定不动", () => {
    for (const ev of [100, 1000, 10000]) {
      const v = judge(stat({ evaluated: ev, hits: 2 }));
      expect(v.message).toContain("未成熟");
      expect(v.action).toBeNull();
    }
  });
});
