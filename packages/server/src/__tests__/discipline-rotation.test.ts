/**
 * 学科轮转必须真的轮起来（8-17）。
 *
 * 旧写法 `discs[i % discs.length]` 里 `i` 只到 `count-1`（=3），且每天从 0 重来，
 * 于是 13 个学科里永远只用前 4 个 —— 实测近 4 天全库只有
 * education 56 / generic 44 / medicine 12 被碰过，其余 **0**。
 */
import { describe, it, expect } from "vitest";
import { disciplineForSlot, rotationOffsetForDay } from "../services/recommendation/daily-cron.js";
import { DISCIPLINE_CODES } from "../services/recommendation/discipline-mapping.js";

const DISCS = [...DISCIPLINE_CODES];
/** 生产实况：每类型 4 篇 */
const COUNT = 4;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

describe("① 连续 30 天，每个学科都要被轮到", () => {
  it("30 天 × 每天 4 个槽位 → 13 个学科全覆盖", () => {
    const seen = new Set<string>();
    for (let d = 0; d < 30; d++) {
      for (let i = 0; i < COUNT; i++) seen.add(disciplineForSlot(DISCS, i, day(d)));
    }
    const missed = DISCS.filter((x) => !seen.has(x));
    expect(missed, `这些学科 30 天内一次都没轮到: ${missed.join(", ")}`).toEqual([]);
  });

  /**
   * 🔴 反向锁：旧写法在同样的 30 天里只能覆盖 4 个。
   * 锁住这个对比，免得有人"简化"回去。
   */
  it("旧写法在同样条件下只覆盖 4 个 —— 这就是被修掉的东西", () => {
    const old = new Set<string>();
    for (let d = 0; d < 30; d++) {
      for (let i = 0; i < COUNT; i++) old.add(DISCS[i % DISCS.length]!);
    }
    expect(old.size).toBe(4);
    expect([...old]).toEqual(["medicine", "education", "economics", "engineering"]);
  });
});

describe("② 同一天内不重复，跨天要推进", () => {
  it("同一天的 4 个槽位拿到 4 个不同学科", () => {
    const d = day(7);
    const got = Array.from({ length: COUNT }, (_, i) => disciplineForSlot(DISCS, i, d));
    expect(new Set(got).size).toBe(COUNT);
  });

  it("相邻两天的起点不同（真的在推进）", () => {
    expect(disciplineForSlot(DISCS, 0, day(3))).not.toBe(disciplineForSlot(DISCS, 0, day(4)));
  });

  it("同一天多次调用结果一致（可复现，不依赖调用顺序）", () => {
    const d = day(11);
    expect(disciplineForSlot(DISCS, 2, d)).toBe(disciplineForSlot(DISCS, 2, d));
  });
});

describe("③ 边界", () => {
  it("空学科表 → generic 兜底，不抛错", () => {
    expect(disciplineForSlot([], 0, day(1))).toBe("generic");
  });

  it("槽位数超过学科数时回绕，不越界", () => {
    const got = Array.from({ length: 20 }, (_, i) => disciplineForSlot(DISCS, i, day(2)));
    expect(got.every((x) => DISCS.includes(x as never))).toBe(true);
  });

  it("偏移随日期单调推进（跨年也不倒退到负数）", () => {
    expect(rotationOffsetForDay(new Date(Date.UTC(2026, 0, 1)))).toBeGreaterThanOrEqual(0);
    expect(rotationOffsetForDay(new Date(Date.UTC(2026, 11, 31)))).toBeGreaterThan(360);
  });
});
