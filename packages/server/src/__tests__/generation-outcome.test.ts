/**
 * 8-02 生成结果闭环 —— 从 daily-cron 搬过来的保护。
 *
 * 【为什么搬】原来 zero_output / low_output 由 runDailyContentByType 落, 判据是
 *   `totalProduced = batchIds.length + roundupCount` = **入队数**(createBatch 只是 db.insert),
 *   而真正的生成在下游 batch-worker 异步跑。于是入队成功就报绿, 哪怕下游一篇没生出来 ——
 *   实测近 14 天 batch_rows 失败 416/成功 526, 这两条 incident **一条都没落过**。
 *   欠费/AI 挂掉恰恰长这样: 入队照常成功(几条 DB insert), 下游全军覆没, 告警一片绿。
 *   且 daily-cron 03:00 跑完时一篇都还没生成 —— 在那里查 contents 永远是 0。
 *   → 判定搬到简报侧(09:30, 批次早跑完), 按**当天实际生成的 contents 条数**。
 *
 * 对应的旧断言已在 tier1-goal-closure.test.ts 翻转为"daily-cron 不再落这两条"。
 */
import { describe, it, expect } from "vitest";

const {
  judgeGenerationOutcome, OUTCOME_LOW_RATIO, PIPELINE_FAIL_RATIO, PIPELINE_MIN_ROWS,
} = await import("../services/ops/generation-outcome.js");

const base = { generated: 30, target: 30, batchTotal: 30, batchFailed: 0 };
const kinds = (o: Parameters<typeof judgeGenerationOutcome>[0]) =>
  judgeGenerationOutcome(o).map((v) => v.kind);

describe("zero_output —— 看实际生成条数, 不看入队数", () => {
  it("实际生成 0 → zero_output(error)", () => {
    const v = judgeGenerationOutcome({ ...base, generated: 0 });
    expect(v[0]!.kind).toBe("zero_output");
    expect(v[0]!.severity).toBe("error");
  });

  it("🔴 关键区分: 入队了却一篇没生出来 → 措辞指向**生成环节**(而不是排产)", () => {
    const v = judgeGenerationOutcome({ generated: 0, target: 30, batchTotal: 617, batchFailed: 416 });
    expect(v[0]!.message).toContain("卡在生成环节");
    expect(v[0]!.message).toContain("617");
  });

  it("连队列都没进过行 → 措辞指向**排产环节**(两种病, 排查方向完全不同)", () => {
    const v = judgeGenerationOutcome({ generated: 0, target: 30, batchTotal: 0, batchFailed: 0 });
    expect(v[0]!.message).toContain("卡在排产环节");
  });
});

describe("low_output —— 实际生成 < 目标 60%", () => {
  it("目标 30 实际 10(33%) → low_output(warn)", () => {
    const v = judgeGenerationOutcome({ ...base, generated: 10 });
    expect(v.map((x) => x.kind)).toContain("low_output");
    expect(v.find((x) => x.kind === "low_output")!.severity).toBe("warn");
  });

  it("达标(≥60%)不报: 目标 30 实际 20", () => {
    expect(kinds({ ...base, generated: 20 })).not.toContain("low_output");
    expect(OUTCOME_LOW_RATIO).toBe(0.6);
  });

  it("零产出与产出不足互斥, 不重复打扰", () => {
    const k = kinds({ ...base, generated: 0 });
    expect(k).toContain("zero_output");
    expect(k).not.toContain("low_output");
  });

  it("没有目标(target=0)时不判产出不足 —— 没排产就不该说它不够", () => {
    expect(kinds({ ...base, generated: 1, target: 0 })).not.toContain("low_output");
  });
});

describe("generation_pipeline_unhealthy —— batch_rows 自比(08-01 那个洞的直接守卫)", () => {
  it("🔴 用事故真实数字: 入队 617 失败 416(67%) → 报警", () => {
    const v = judgeGenerationOutcome({ generated: 219, target: 30, batchTotal: 617, batchFailed: 416 });
    const p = v.find((x) => x.kind === "generation_pipeline_unhealthy");
    expect(p).toBeTruthy();
    expect(p!.severity).toBe("error");
    expect(p!.message).toContain("67%");
  });

  it("正常日(失败 0%)不报 —— 实测 19 天稳定 0%", () => {
    expect(kinds(base)).not.toContain("generation_pipeline_unhealthy");
  });

  it("样本太小不判(3 行挂 1 行 = 33% 是噪音不是信号)", () => {
    expect(kinds({ ...base, batchTotal: 3, batchFailed: 1 })).not.toContain("generation_pipeline_unhealthy");
    expect(PIPELINE_MIN_ROWS).toBe(10);
  });

  it("阈值 20%: 刚好 20% 不报, 超过才报", () => {
    expect(kinds({ ...base, batchTotal: 100, batchFailed: 20 })).not.toContain("generation_pipeline_unhealthy");
    expect(kinds({ ...base, batchTotal: 100, batchFailed: 21 })).toContain("generation_pipeline_unhealthy");
    expect(PIPELINE_FAIL_RATIO).toBe(0.2);
  });

  it("产出正常但链路失败率高 → 只报链路异常, 不误报产出不足", () => {
    const k = kinds({ generated: 30, target: 30, batchTotal: 100, batchFailed: 50 });
    expect(k).toEqual(["generation_pipeline_unhealthy"]);
  });
});

describe("采集失败时的行为", () => {
  it("generated < 0(采集失败标记) → 一条都不判(宁可不报, 不可乱报)", () => {
    expect(judgeGenerationOutcome({ generated: -1, target: 30, batchTotal: 617, batchFailed: 416 })).toEqual([]);
  });
});
