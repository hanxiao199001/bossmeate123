/**
 * DVH 孤儿任务出生即 exhausted（8-12）。
 *
 * 孤儿任务 = 已提交(**已按 0.165 元/秒扣过费**)但取不回成片。
 * 自动重跑对它意味着**再付一次钱**，而正确动作是凭 taskUuid 去阿里云捞回。
 * 在「重跑优先 re-query」做出来之前，这类一律不进自动重跑队列。
 */
import { describe, it, expect } from "vitest";

const { buildDeferred, canAutoRetry } = await import("../services/ops/deferred.js");
const { DvhOrphanTaskError, DvhSubmitFailedError } = await import("../services/digital-human/produce-video.js");

const INPUT = {
  kind: "dvh_text" as const,
  tenantId: "t1",
  userId: "u1",
  text: "口播稿原文",
  templateId: "A_academic",
};

describe("孤儿任务(已扣费)不进自动重跑", () => {
  it("DvhOrphanTaskError → exhausted=true, 不自动重跑", () => {
    const mark = buildDeferred({ err: new DvhOrphanTaskError("task-1", "query timeout"), input: INPUT });
    expect(mark).toBeTruthy();
    expect(mark!.exhausted).toBe(true);
    expect(canAutoRetry(mark!)).toBe(false);
  });

  it("taskUuid 必须留在错误里 —— 丢了就等于把那笔钱扔了", () => {
    const err = new DvhOrphanTaskError("task-42", "query timeout");
    expect(err.taskUuid).toBe("task-42");
    expect(buildDeferred({ err, input: INPUT })!.lastError).toContain("task-42");
  });

  /** 防过度收紧：未扣费的那类照旧自动重跑，别把两种失败一起判死 */
  it("DvhSubmitFailedError(未扣费) → 照常自动重跑", () => {
    const mark = buildDeferred({ err: new DvhSubmitFailedError("10010003 无访问权限"), input: INPUT });
    expect(mark).toBeTruthy();
    expect(mark!.exhausted).toBeUndefined();
    expect(canAutoRetry(mark!)).toBe(true);
  });
});
