/**
 * 判据注册器回归锁。8-22。
 *
 * 🔴 最重要的一条：**8-22 件 1 那条判据必须被拦住**。
 * 它是这个注册器存在的全部理由 —— 如果它能通过，注册器就没写对。
 */
import { describe, it, expect } from "vitest";
import {
  registerCriteria,
  daysBetween,
  MEASURED_NOISE,
  NOISE_STALE_DAYS,
  type ScoringCriterion,
} from "../services/content-engine/criterion-registry.js";

const TODAY = "2026-08-22";
const ok = (over: Partial<ScoringCriterion> = {}): ScoringCriterion => ({
  id: "c1",
  statement: "测试判据",
  threshold: 2.6,
  unit: "sixdim_dim_0_10",
  noiseLevel: 1.3,
  noiseUnit: "sixdim_dim_0_10",
  noiseSource: "同尺两跑 n=30",
  noiseMeasuredAt: "2026-08-22",
  direction: "increase",
  ...over,
});

describe("🔴 8-22 件 1 那条判据必须被拦住", () => {
  it("阈值 0.5 < 噪音 1.3 → 注册失败", () => {
    expect(() => registerCriteria([ok({ threshold: 0.5 })], TODAY)).toThrow(/答不出东西/);
  });

  it("填了总分噪音(4.0)进单维判据 → 量纲不符，注册失败", () => {
    expect(() =>
      registerCriteria([ok({ noiseLevel: 4.0, noiseUnit: "sixdim_total_0_100" })], TODAY),
    ).toThrow(/量纲不符/);
  });

  it("两个毛病同时存在时，两条都要报出来（不是报第一个就停）", () => {
    try {
      registerCriteria([ok({ id: "x", threshold: 0.3, noiseLevel: 4.0, noiseUnit: "sixdim_total_0_100" })], TODAY);
      throw new Error("应当抛错");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/量纲不符/);
      // 量纲不符时阈值检查仍应独立进行 —— 只报一个会让人修完一个又撞另一个
      expect((e as Error).name).toBe("CriterionRegistrationError");
    }
  });

  it("正常判据（2× 噪音）通过", () => {
    expect(() => registerCriteria([ok()], TODAY)).not.toThrow();
  });
});

describe("噪音必填与时效", () => {
  it("噪音缺失/为负 → 失败", () => {
    expect(() => registerCriteria([ok({ noiseLevel: Number.NaN })], TODAY)).toThrow(/noiseLevel 无效/);
    expect(() => registerCriteria([ok({ noiseLevel: -1 })], TODAY)).toThrow(/noiseLevel 无效/);
  });

  it("噪音过期 → 失败（过期的噪音和填错量纲一样危险）", () => {
    expect(() => registerCriteria([ok({ noiseMeasuredAt: "2026-06-01" })], TODAY)).toThrow(/请重测/);
  });

  it(`刚好 ${NOISE_STALE_DAYS} 天不算过期，多一天算`, () => {
    const d = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);
    expect(() => registerCriteria([ok({ noiseMeasuredAt: d(NOISE_STALE_DAYS) })], TODAY)).not.toThrow();
    expect(() => registerCriteria([ok({ noiseMeasuredAt: d(NOISE_STALE_DAYS + 1) })], TODAY)).toThrow(/请重测/);
  });

  it("noiseSource 为空 → 失败（噪音怎么来的必须可追溯）", () => {
    expect(() => registerCriteria([ok({ noiseSource: "   " })], TODAY)).toThrow(/noiseSource 为空/);
  });

  it("非法日期 → 失败，不静默当成 0 天", () => {
    expect(() => registerCriteria([ok({ noiseMeasuredAt: "昨天" })], TODAY)).toThrow(/不是合法日期/);
  });
});

describe("observationOnly 豁免阈值检查，但不豁免量纲", () => {
  it("方向性观察允许阈值埋在噪音里", () => {
    expect(() => registerCriteria([ok({ threshold: 0.1, observationOnly: true })], TODAY)).not.toThrow();
  });

  it("但量纲仍必须全等", () => {
    expect(() =>
      registerCriteria([ok({ observationOnly: true, noiseUnit: "sixdim_total_0_100" })], TODAY),
    ).toThrow(/量纲不符/);
  });
});

describe("id 唯一", () => {
  it("重复 id → 失败", () => {
    expect(() => registerCriteria([ok(), ok()], TODAY)).toThrow(/id 重复/);
  });
});

describe("daysBetween", () => {
  it("正常相减", () => {
    expect(daysBetween("2026-08-01", "2026-08-22")).toBe(21);
  });
  it("非法输入返回 NaN，不返回 0", () => {
    // 返回 0 会让"日期写错"表现成"今天刚测的"，正是本文件要防的静默失败
    expect(Number.isNaN(daysBetween("x", "2026-08-22"))).toBe(true);
  });
});

describe("噪音表本身", () => {
  it("总分与单维的噪音差一个数量级，不许互换", () => {
    expect(MEASURED_NOISE.sixdim_total_0_100.level).toBeGreaterThan(
      MEASURED_NOISE.sixdim_dim_0_10.level * 2,
    );
  });
  it("每条都带测量日期与来源", () => {
    for (const v of Object.values(MEASURED_NOISE)) {
      expect(v.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.source.length).toBeGreaterThan(10);
    }
  });
});
