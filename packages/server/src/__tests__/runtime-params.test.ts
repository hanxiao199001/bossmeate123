/**
 * 运行时参数（Phase 4 第一批）的纯逻辑部分。
 *
 * 验收是「老韩不碰代码改掉一个阈值」，所以这里锁的是**交到运营手里之后不会出事**的那些性质。
 */
import { describe, it, expect } from "vitest";
import { REGISTRY, validate, getParamDef, type ParamDef } from "../services/ops/runtime-params.js";

describe("① 每个参数都得能被运营看懂", () => {
  it("都有 label 与 impact，且 impact 说的是「改了会怎样」不是「它是什么」", () => {
    for (const d of REGISTRY) {
      expect(d.label.length, d.key).toBeGreaterThan(3);
      expect(d.impact.length, `${d.key} 的 impact 太短，等于没解释`).toBeGreaterThan(20);
    }
  });

  it("数值型都必须有边界 —— 没有边界的参数页等于把方向盘拆下来递过去", () => {
    for (const d of REGISTRY.filter((x) => x.type === "number")) {
      expect(d.min, `${d.key} 缺 min`).toBeDefined();
      expect(d.max, `${d.key} 缺 max`).toBeDefined();
      expect(d.min!).toBeLessThan(d.max!);
    }
  });

  it("key 唯一", () => {
    expect(new Set(REGISTRY.map((d) => d.key)).size).toBe(REGISTRY.length);
  });
});

describe("② 边界校验在写入侧生效", () => {
  const q = getParamDef("quality.minScore")!;

  it("越界值被拒", () => {
    expect(validate(q, -1).ok).toBe(false);
    expect(validate(q, 101).ok).toBe(false);
    expect(validate(q, "abc").ok).toBe(false);
  });

  it("边界值本身放行（闭区间）", () => {
    expect(validate(q, q.min!).ok).toBe(true);
    expect(validate(q, q.max!).ok).toBe(true);
  });

  it("布尔型只收 true/false，不收 'true' 字符串或 1", () => {
    const g = getParamDef("gate.outputHealthEnabled")!;
    expect(validate(g, true).ok).toBe(true);
    expect(validate(g, "true").ok).toBe(false);
    expect(validate(g, 1).ok).toBe(false);
  });

  /**
   * 🔴 冷却不能填 0：填 0 等于同一本刊可以天天上。
   * 这条不是理论风险 —— education 池现在可选只剩个位数，冷却一松就会全是回头刊。
   */
  it("冷却类参数的下界不为 0", () => {
    for (const k of ["journal.cooldownDays", "keyword.cooldownDays"]) {
      const d = getParamDef(k)!;
      expect(d.min, k).toBeGreaterThanOrEqual(1);
      expect(validate(d, 0).ok, `${k} 不该允许 0`).toBe(false);
    }
  });
});

describe("③ 上线当天行为不变", () => {
  /**
   * 外化只是把值搬了个家。fallback 必须**等于**外化之前的硬编码值，
   * 否则"参数化"这个动作本身就改了行为 —— 而那是最难查的一类事故。
   */
  const expectedFallback: Record<string, number | boolean> = {
    "quality.minScore": 70,        // env QUALITY_MIN_SCORE 的 default
    "journal.cooldownDays": 15,    // journal-sql 的 15 天
    "keyword.cooldownDays": 30,    // daily-cron 的 KEYWORD_COOLDOWN_DAYS
    "gate.outputHealthEnabled": true,
  };

  for (const [key, want] of Object.entries(expectedFallback)) {
    it(`${key} 的默认值仍是 ${want}`, () => {
      expect((getParamDef(key) as ParamDef).fallback).toBe(want);
    });
  }
});

describe("④ 学科配额不该在第一批", () => {
  /**
   * 它的口径正在改（配额按槽位学科计 vs 按刊学科计），
   * 外化一个即将作废的旋钮，等于把错的方向盘交给运营。
   */
  it("注册表里没有学科配额", () => {
    expect(REGISTRY.some((d) => /discipline.*quota|quota.*discipline/i.test(d.key))).toBe(false);
  });
});
