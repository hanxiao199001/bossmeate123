/**
 * Golden Set 采样策略单测(8-02)。
 *
 * 锁的是"代表性"这四条: 分数段覆盖 / 未评分单列 / 形态与状态打散 / 时间跨度分散。
 * 这些不是好看的性质, 是这批标注数据能不能用来算相关性的前提 ——
 * 全标高分内容, 人机都说"好", 相关性虚高到没有信息量, 而且从数据本身看不出来。
 */
import { describe, it, expect } from "vitest";
import { planSample, scoreBand, weekBucket, type PoolItem } from "../services/golden-set/sampling.js";

function mk(
  id: string,
  score: number | null,
  kind: string,
  status: string,
  createdAt: string,
  degraded = false,
): PoolItem {
  return { id, score, kind, status, createdAt, degraded };
}

describe("scoreBand — 分数段切分", () => {
  it("按 85 / 70 切 high / mid / low", () => {
    expect(scoreBand(92)).toBe("high");
    expect(scoreBand(85)).toBe("high");
    expect(scoreBand(84)).toBe("mid");
    expect(scoreBand(70)).toBe("mid");
    expect(scoreBand(69)).toBe("low");
    expect(scoreBand(0)).toBe("low");
  });

  it("🔴 未评分 ≠ 0 分: null / degraded / NaN 一律 unscored(7-27 质检超时事故的教训)", () => {
    expect(scoreBand(null)).toBe("unscored");
    expect(scoreBand(undefined)).toBe("unscored");
    expect(scoreBand(Number.NaN)).toBe("unscored");
    // degraded = 主+降级模型都没救回来, 这篇根本没评上分。哪怕带了个数也不算数。
    expect(scoreBand(80, true)).toBe("unscored");
    // 反面锁: 0 分是真评出来的低分, 不能被当成未评分
    expect(scoreBand(0, false)).toBe("low");
  });
});

describe("weekBucket — 时间分桶", () => {
  it("同一 ISO 周归同一桶, 跨周分开", () => {
    expect(weekBucket("2026-06-01T00:00:00Z")).toBe(weekBucket("2026-06-05T23:00:00Z"));
    expect(weekBucket("2026-06-01T00:00:00Z")).not.toBe(weekBucket("2026-06-10T00:00:00Z"));
  });
  it("非法时间不炸, 落 unknown 桶", () => {
    expect(weekBucket("not-a-date")).toBe("unknown");
  });
});

describe("planSample — 分层采样", () => {
  /** 造一个四段齐全、四形态齐全、跨 10 周的池子 */
  function buildPool(): PoolItem[] {
    const kinds = ["domestic", "international", "roundup", "video"];
    const statuses = ["published", "needs_review", "generated"];
    const out: PoolItem[] = [];
    let n = 0;
    for (const [band, score] of [["high", 90], ["mid", 78], ["low", 55], ["unscored", null]] as const) {
      for (let i = 0; i < 20; i++) {
        const week = i % 10;
        out.push(
          mk(
            `${band}-${i}`,
            score,
            kinds[(n + i) % kinds.length]!,
            statuses[(n + i) % statuses.length]!,
            `2026-0${1 + Math.floor(week / 5)}-${String(1 + (week % 5) * 7).padStart(2, "0")}T08:00:00Z`,
          ),
        );
      }
      n++;
    }
    return out;
  }

  it("覆盖全部四个分数段(含未评分), 且大致均分", () => {
    const r = planSample(buildPool(), 40);
    expect(r.ids).toHaveLength(40);
    for (const band of ["high", "mid", "low", "unscored"] as const) {
      expect(r.bandCounts[band]).toBeGreaterThanOrEqual(8); // 40/4=10, 允许贪心带来的小偏差
    }
  });

  it("覆盖多种内容形态 + 多种状态(不会全是国内刊/全是已发布)", () => {
    const r = planSample(buildPool(), 40);
    expect(Object.keys(r.kindCounts).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(r.statusCounts).length).toBeGreaterThanOrEqual(3);
    // 最大形态占比不超过一半 —— 防"名义上分层, 实际一边倒"
    const max = Math.max(...Object.values(r.kindCounts));
    expect(max).toBeLessThanOrEqual(20);
  });

  it("时间跨度分散: 不会全落在同一周", () => {
    const r = planSample(buildPool(), 40);
    expect(Object.keys(r.weekCounts).length).toBeGreaterThanOrEqual(5);
  });

  it("某一段稀缺时, 名额自动流给其他段(不因凑不齐配额而少给样本)", () => {
    const pool: PoolItem[] = [
      mk("h1", 95, "domestic", "published", "2026-06-01T00:00:00Z"),
      mk("h2", 92, "international", "published", "2026-06-08T00:00:00Z"),
      // low 只有 1 条
      mk("l1", 40, "roundup", "needs_review", "2026-05-01T00:00:00Z"),
      mk("m1", 75, "video", "generated", "2026-04-01T00:00:00Z"),
      mk("m2", 72, "domestic", "generated", "2026-03-01T00:00:00Z"),
      mk("m3", 71, "domestic", "published", "2026-02-01T00:00:00Z"),
    ];
    const r = planSample(pool, 6);
    expect(r.ids).toHaveLength(6); // 池子只有 6 条, 全要
    expect(new Set(r.ids).size).toBe(6); // 不重复
    expect(r.bandCounts.low).toBe(1);
  });

  it("结果顺序在分数段之间交替(老板不会连着标 10 篇高分)", () => {
    const r = planSample(buildPool(), 8);
    const bandOf = (id: string) => id.split("-")[0];
    const first4 = r.ids.slice(0, 4).map(bandOf);
    expect(new Set(first4).size).toBe(4); // 前 4 条恰好四段各一
  });

  it("确定性: 同一输入两次调用结果完全一致(回归基准可复现)", () => {
    const pool = buildPool();
    expect(planSample(pool, 25).ids).toEqual(planSample(pool, 25).ids);
  });

  it("边界: 空池 / limit=0 / limit 大于池子, 都不炸也不重复", () => {
    expect(planSample([], 10).ids).toEqual([]);
    expect(planSample(buildPool(), 0).ids).toEqual([]);
    const all = planSample(buildPool(), 999);
    expect(all.ids).toHaveLength(80);
    expect(new Set(all.ids).size).toBe(80);
  });
});
