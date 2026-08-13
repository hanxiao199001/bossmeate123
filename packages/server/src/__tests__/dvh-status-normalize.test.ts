/**
 * DVH 任务状态归一（8-13）。
 *
 * 这个字段有前科：PR #239 按 `typeof === "number"` 判，实测阿里云回的是**字符串 "3"**，
 * 判定漏过；PR #240 才改 `Number()`。为免第三次踩，判定收口到一个函数并在这里锁死两种形态。
 *
 * ⚠️ 8-13 补充：本轮 5 条失败任务**并不是**栽在这里 —— 轮询器确实进了失败分支、
 * 也确实把 failCode 抛了出来。信息是在**上一层** `if (taskUuid)` 丢的（一律当孤儿）。
 * 这组测试仍然保留：判据收口本身是对的，且它是那一层能分辨两种失败的前提。
 */
import { describe, it, expect } from "vitest";

const { normalizeDvhStatus, isDvhSuccessStatus, isDvhFailStatus, DvhTaskFailedError } = await import(
  "../services/digital-human/query-task.js"
);

describe("状态归一：数字与数字字符串必须等价", () => {
  it.each([
    [3, true],
    ["3", true],
    [" 3 ", true],
    ["SUCCESS", true],
    ["succeeded", true],
    [2, false],
    ["2", false],
    [4, false],
  ])("isDvhSuccessStatus(%o) = %s", (raw, want) => {
    expect(isDvhSuccessStatus(raw)).toBe(want);
  });

  it.each([
    [4, true],
    ["4", true],
    [5, true],
    ["FAILED", true],
    ["failure", true],
    [3, false],
    ["3", false],
    [1, false],
    [undefined, false],
    [null, false],
    ["", false],
  ])("isDvhFailStatus(%o) = %s", (raw, want) => {
    expect(isDvhFailStatus(raw)).toBe(want);
  });

  it("非数字非关键词 → 既不算成功也不算失败（继续轮询，别误判）", () => {
    expect(isDvhSuccessStatus("RUNNING")).toBe(false);
    expect(isDvhFailStatus("RUNNING")).toBe(false);
    expect(Number.isNaN(normalizeDvhStatus("RUNNING").num)).toBe(true);
  });
});

describe("失败错误必须带上 API 给的原因", () => {
  /** API 给的原因永远优先于我们的猜测 —— 丢了它，5 条 10010002 就会再次变成"取不回" */
  it("failCode / failReason / taskUuid 都在错误对象里", () => {
    const e = new DvhTaskFailedError({
      taskUuid: "t-1",
      failCode: "10010002",
      failReason: "图片分辨率必须与输出的视频分辨率一致",
      rawStatus: "4",
    });
    expect(e.name).toBe("DvhTaskFailedError");
    expect(e.failCode).toBe("10010002");
    expect(e.message).toContain("10010002");
    expect(e.message).toContain("图片分辨率");
  });

  it("被判 content_error → 不自动重跑（每次重跑都先扣费再失败）", async () => {
    const { classifyFailure } = await import("../services/ops/failure-kind.js");
    const e = new DvhTaskFailedError({ taskUuid: "t", failCode: "10010002", failReason: "x", rawStatus: "4" });
    expect(classifyFailure(e)).toBe("content_error");
  });

  it("真·孤儿(查不到)仍归 service_down —— 两种失败别再合并", async () => {
    const { classifyFailure } = await import("../services/ops/failure-kind.js");
    const { DvhOrphanTaskError } = await import("../services/digital-human/produce-video.js");
    expect(classifyFailure(new DvhOrphanTaskError("t", "query timeout"))).toBe("service_down");
  });
});
