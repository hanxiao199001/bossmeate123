/**
 * 检查器裁决（Phase 3 后端数据路径）的纯函数部分。
 *
 * 落库路径不在这里测（要连库）；这里锁的是三条**错了会静默污染台账**的规则。
 */
import { describe, it, expect } from "vitest";
import { VERDICTS, SAMPLE_SIZE, adjudicationDeltas } from "../services/ops/checker-adjudication.js";
import { MIN_ADJUDICATED } from "../services/ops/checker-ledger.js";

describe("① 裁决口径", () => {
  it("三种裁决缺一不可 —— 少了 miss 就只能证明闸报错了，永远发现不了漏网", () => {
    expect([...VERDICTS].sort()).toEqual(["false_positive", "miss", "true_positive"]);
  });

  it("一次抽样的量要够攒出结论 —— 一周一次、10 条，两周就过门槛", () => {
    expect(SAMPLE_SIZE * 2).toBeGreaterThanOrEqual(MIN_ADJUDICATED);
  });
});

describe("② 抽样必须可复现", () => {
  /**
   * 用 Math.random 抽样的话，前端刷新一次就换一批，判过的又冒出来、没判的沉底。
   * 这里锁的是"同样的输入给同样的顺序"这条性质本身。
   */
  it("哈希定序：同一组 (contentId, checkerId) 每次得到相同名次", () => {
    const key = (contentId: string, checkerId: string) => {
      let x = 0;
      const s = `${contentId}${checkerId}`;
      for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
      return x;
    };
    const a = key("11111111-1111-1111-1111-111111111111", "output_health.body_too_short");
    const b = key("11111111-1111-1111-1111-111111111111", "output_health.body_too_short");
    const c = key("22222222-2222-2222-2222-222222222222", "output_health.body_too_short");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("③ 改判不许叠票", () => {
  it("首次裁决只加一票", () => {
    expect(adjudicationDeltas(null, "true_positive")).toEqual([{ verdict: "true_positive", delta: 1 }]);
  });

  /**
   * 只 +1 不 -1 的话，台账记成一真一假两票 —— 正好把判定拉向中间，
   * 看数字的人完全察觉不到。这是这条规则唯一的存在理由。
   */
  it("改判：先撤旧票，再投新票", () => {
    expect(adjudicationDeltas("true_positive", "false_positive")).toEqual([
      { verdict: "true_positive", delta: -1 },
      { verdict: "false_positive", delta: 1 },
    ]);
  });

  it("重复提交同一结论 → 一票都不动（不是加零，是压根不写）", () => {
    expect(adjudicationDeltas("miss", "miss")).toEqual([]);
  });

  it("撤票与投票永远成对，净增不超过 1", () => {
    for (const prev of [null, ...VERDICTS] as const) {
      for (const next of VERDICTS) {
        const sum = adjudicationDeltas(prev as never, next).reduce((a, d) => a + d.delta, 0);
        expect(sum).toBeLessThanOrEqual(1);
      }
    }
  });
});
