/**
 * 5-23 PR #239 — 阿里云数字人 GetVideoTaskInfo status 实测返回数字 (1/2/3) 不是字符串.
 * PR #238 代码只判 "SUCCESS"/"SUCCEEDED" 漏过 status=3, 导致渲染完成仍 timeout 10min fallback mock.
 * 修: 兼容字符串 + 数字双轨判断. 数字 3 视为 SUCCESS, 数字 ≥4 视为 FAILED (保守).
 *
 * ## 🔴 8-13 改写：从「断言源码文本」改成「断言行为」
 *
 * 原来这几条是 `readFile(query-task.ts)` 然后 regex 匹配实现代码的字面串，
 * 例如 `expect(src).toMatch(/statusStr === "SUCCESS" \|\| .../)`。
 * 后果：**判定逻辑收口成函数（一个纯粹的改善）就会让它们全红**，
 * 而它们要守的东西（数字/字符串双轨兼容）其实一个字都没变。
 * 锁写法不锁行为的测试，会把重构本身变成"回归"，久了就没人敢动代码。
 *
 * 现在直接调导出的判定函数。同一批意图，换成改不坏的断言方式。
 */
import { describe, it, expect } from "vitest";

const { isDvhSuccessStatus, isDvhFailStatus, normalizeDvhStatus, DvhTaskFailedError } = await import(
  "../services/digital-human/query-task.js"
);

describe("PR #239: status 数字兼容", () => {
  it("成功条件: 字符串 SUCCESS/SUCCEEDED 或 数字 3（数字与数字字符串等价）", () => {
    for (const raw of [3, "3", "SUCCESS", "succeeded", "SUCCEEDED"]) {
      expect(isDvhSuccessStatus(raw)).toBe(true);
    }
    for (const raw of [1, 2, "2", 4, "RUNNING"]) {
      expect(isDvhSuccessStatus(raw)).toBe(false);
    }
  });

  it("失败条件: 字符串 FAIL/FAILED/FAILURE 或 数字 >=4", () => {
    for (const raw of [4, "4", 5, 99, "FAIL", "failed", "FAILURE"]) {
      expect(isDvhFailStatus(raw)).toBe(true);
    }
    for (const raw of [1, 2, 3, "3", "RUNNING"]) {
      expect(isDvhFailStatus(raw)).toBe(false);
    }
  });

  it("rawStatus 保留原值，归一只发生在比较时（数字不被 toUpperCase 毁掉）", () => {
    expect(normalizeDvhStatus(3)).toEqual({ text: "3", num: 3 });
    expect(normalizeDvhStatus("success")).toEqual({ text: "SUCCESS", num: Number.NaN });
    expect(normalizeDvhStatus(undefined).text).toBe("");
  });

  /** 排队/渲染中既不算成功也不算失败 —— 误判任一边都会中断轮询 */
  it("中间态两边都不沾", () => {
    for (const raw of [1, 2, "1", "2", "RUNNING", "PROCESSING"]) {
      expect(isDvhSuccessStatus(raw)).toBe(false);
      expect(isDvhFailStatus(raw)).toBe(false);
    }
  });

  it("失败错误带 rawStatus 与 failCode/failReason（诊断靠它）", () => {
    const e = new DvhTaskFailedError({
      taskUuid: "t-1",
      failCode: "10010002",
      failReason: "图片分辨率必须与输出的视频分辨率一致",
      rawStatus: "4",
    });
    expect(e.message).toContain("status=4");
    expect(e.message).toContain("10010002");
    expect(e.rawStatus).toBe("4");
  });
});
