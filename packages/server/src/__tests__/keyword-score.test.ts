/**
 * 关键词打分：验收判据的可执行形式（8-17）。
 *
 * 老韩定的两条验收：**满分条数 < 总数 5%、TOP100 有梯度**。
 * 这里用真实分布形态构造样本跑一遍 —— 而不是只测"函数返回了个数"。
 */
import { describe, it, expect } from "vitest";
import { computeKeywordScore, scoreDistributionHealth, RECENT_PICK_DAYS } from "../services/agents/keyword-score.js";

const NOW = new Date("2026-08-17T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const base = { heatScore: 100, appearCount: 1, lastSeenAt: daysAgo(0), platformCount: 1, now: NOW };

describe("① 饱和输入必须被区分开", () => {
  /**
   * 🔴 这是重写的全部理由：旧公式下这三条都是 300 分。
   * 它们的 heat 都顶格，但持续度天差地别 —— 分数必须能分辨。
   */
  it("heat 都是 100，但出现次数不同 → 分数必须不同", () => {
    const once = computeKeywordScore({ ...base, appearCount: 1 });
    const some = computeKeywordScore({ ...base, appearCount: 20 });
    const many = computeKeywordScore({ ...base, appearCount: 150 });
    expect(once).toBeLessThan(some);
    expect(some).toBeLessThan(many);
  });

  it("同样的出现次数，越新鲜分越高", () => {
    const fresh = computeKeywordScore({ ...base, appearCount: 20, lastSeenAt: daysAgo(0) });
    const stale = computeKeywordScore({ ...base, appearCount: 20, lastSeenAt: daysAgo(60) });
    expect(fresh).toBeGreaterThan(stale);
  });

  it("跨平台是加分项，但边际递减", () => {
    const one = computeKeywordScore({ ...base, platformCount: 1 });
    const two = computeKeywordScore({ ...base, platformCount: 2 });
    const five = computeKeywordScore({ ...base, platformCount: 5 });
    expect(two).toBeGreaterThan(one);
    expect(five - two).toBeLessThan(two - one + 0.01);
  });
});

describe("② 防霸榜", () => {
  it("刚被选过的词分数被压低，14 天后恢复", () => {
    const arg = { ...base, appearCount: 50 };
    const justPicked = computeKeywordScore({ ...arg, lastRecommendedAt: daysAgo(0) });
    const halfWay = computeKeywordScore({ ...arg, lastRecommendedAt: daysAgo(RECENT_PICK_DAYS / 2) });
    const recovered = computeKeywordScore({ ...arg, lastRecommendedAt: daysAgo(RECENT_PICK_DAYS) });
    const never = computeKeywordScore(arg);
    expect(justPicked).toBeLessThan(halfWay);
    expect(halfWay).toBeLessThan(recovered);
    expect(recovered).toBeCloseTo(never, 1);
  });

  /**
   * 惩罚必须是**乘性**的：减法会把低分词压成负数再 clamp 到 0，
   * 于是"压一压"对它们等于没压（本来就接近 0）。
   */
  it("惩罚对高分词和低分词都成比例生效", () => {
    const hi = { ...base, appearCount: 150 };
    const lo = { ...base, appearCount: 2, lastSeenAt: daysAgo(40) };
    const hiRatio = computeKeywordScore({ ...hi, lastRecommendedAt: daysAgo(0) }) / computeKeywordScore(hi);
    const loRatio = computeKeywordScore({ ...lo, lastRecommendedAt: daysAgo(0) }) / computeKeywordScore(lo);
    expect(hiRatio).toBeCloseTo(loRatio, 2);
  });
});

describe("③ 验收判据：分布必须散开", () => {
  /**
   * 用**生产实测的形态**造样本：heat 大量顶格(1098/2938 = 37%)、
   * appearCount 1~174、lastSeen 跨 113 天。
   * 旧公式在这批输入上会产出 37% 并列满分；新公式必须过 5% 线。
   */
  const sample = Array.from({ length: 2938 }, (_, i) => {
    const heat = i % 8 === 0 ? 100 : 40 + (i % 60);          // 约 1/8 顶格
    const appear = 1 + (i * 7) % 174;                         // 1~174
    const seenDays = (i * 13) % 113;                          // 跨 113 天
    return computeKeywordScore({
      heatScore: heat,
      appearCount: appear,
      lastSeenAt: daysAgo(seenDays),
      platformCount: 1 + (i % 3 === 0 ? 1 : 0),
      now: NOW,
    });
  });

  it("并列满分 < 5%", () => {
    const h = scoreDistributionHealth(sample);
    expect(h.atMaxRatio, `并列满分 ${h.atMaxCount}/${h.total}`).toBeLessThan(0.05);
  });

  it("TOP100 有梯度（不同分值 ≥ 50%）", () => {
    const h = scoreDistributionHealth(sample);
    expect(h.top100DistinctRatio).toBeGreaterThanOrEqual(0.5);
  });

  it("体检函数在坏分布上必须报红 —— 否则它证明不了任何事", () => {
    const allSame = Array.from({ length: 1000 }, () => 300);
    const h = scoreDistributionHealth(allSame);
    expect(h.healthy).toBe(false);
    expect(h.reasons.join()).toContain("并列满分");
  });
});
