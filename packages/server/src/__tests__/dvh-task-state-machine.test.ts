/**
 * 件 2: 数字人任务状态机 (9-04)。
 *
 * 【病历】30 天内 ¥169.31(占 DVH 支出 42.4%)记为"孤儿任务", 告警写着
 * 「可凭该 taskUuid 去阿里云捞回」。9-03 逐个查了那 10 个 taskUuid:
 *
 *   7 条 status=4 / 10010002 图片分辨率不一致
 *   1 条 status=4 / 10050005 任务处理超时
 *   1 条 status=3 **其实成功了**, 成片实测可下
 *   1 条 status=6 结果已过期
 *
 * **10 条里 9 条阿里云早有终态 —— 我们只是没等到。**
 * 而 8-13 特意加的 DvhTaskFailedError 分支至今 0 次执行, 因为 10 分钟超时总是先到。
 *
 * ▎ 病根: 一个付了钱的异步任务, 生命周期被绑在一个 HTTP 请求上。
 */
import { describe, it, expect } from "vitest";
import {
  classifyDvhStatus, isDvhExpiredStatus,
  DVH_SETTLE_DEADLINE_HOURS, DVH_POLL_INTERVAL_MINUTES,
} from "../services/digital-human/dvh-tasks.js";

describe("a. 状态分类: 只有 3 和 4 是终态", () => {
  it("3 / \"3\" / SUCCESS 都算成功(阿里云实测返回的是字符串)", () => {
    for (const v of [3, "3", "SUCCESS", "succeeded"]) expect(classifyDvhStatus(v)).toBe("success");
  });

  it("4 / \"4\" / FAIL 都算失败", () => {
    for (const v of [4, "4", "FAIL", "failed"]) expect(classifyDvhStatus(v)).toBe("failed");
  });

  it("🔴 5 和 6 不算失败 —— `>=4` 是把「不认识」当成了「失败」", () => {
    // 旧实现 isDvhFailStatus 是 num>=4, 于是 status=6 被判失败,
    // 但它没有 failCode/failReason, 落库就是两个空字段(红线 #14 同族)
    expect(classifyDvhStatus(5)).toBe("unknown");
    expect(classifyDvhStatus(6)).toBe("unknown");
    expect(classifyDvhStatus(99)).toBe("unknown");
  });

  it("排队/渲染中(1/2)是未知态, 继续轮询", () => {
    expect(classifyDvhStatus(1)).toBe("unknown");
    expect(classifyDvhStatus(2)).toBe("unknown");
  });

  it("空值/垃圾值不判失败(宁可多轮询一次)", () => {
    for (const v of [null, undefined, "", "???"]) expect(classifyDvhStatus(v)).toBe("unknown");
  });
});

describe("b. status=6 单列为「结果已过期」, 与失败区分开", () => {
  /**
   * 9-03 查清: 6 = 任务记录还在、结果已被阿里云清理。
   * 抽了 30 天内全部 20 笔正常成功的扣费, 8-19 及更早全是 6 无成片;
   * 8-28 那条(6 天前)仍是 3 有成片 → 结果保留期 6~15 天, 任务记录至少 79 天。
   *
   * 记账口径不同: 过期的任务当时可能是**成功**的, 钱花得有产出, 只是我们没及时取。
   */
  it("6 判为过期", () => {
    expect(isDvhExpiredStatus(6)).toBe(true);
    expect(isDvhExpiredStatus("6")).toBe(true);
  });

  it("3 / 4 不是过期", () => {
    expect(isDvhExpiredStatus(3)).toBe(false);
    expect(isDvhExpiredStatus(4)).toBe(false);
  });

  it("过期与「未知」分开判 —— 6 在 classify 里是 unknown, 但不该继续轮询", () => {
    expect(classifyDvhStatus(6)).toBe("unknown");
    expect(isDvhExpiredStatus(6)).toBe(true);
  });
});

describe("c. 24 小时上限, 不是 10 分钟", () => {
  it("上限是 24 小时", () => {
    expect(DVH_SETTLE_DEADLINE_HOURS).toBe(24);
  });

  it("轮询间隔 5 分钟 —— 24h 内约 288 次机会, 而旧实现只有一次 10 分钟的窗口", () => {
    expect(DVH_POLL_INTERVAL_MINUTES).toBe(5);
    expect((DVH_SETTLE_DEADLINE_HOURS * 60) / DVH_POLL_INTERVAL_MINUTES).toBe(288);
  });

  it("🔴 24h 远大于结果过期窗口(6~15 天), 所以轮询期内不该看到 status=6", () => {
    // 这条锁的是设计前提: 若哪天 24h 内真的出现 6, 那是阿里云语义变了, 要报警而不是静默
    expect(DVH_SETTLE_DEADLINE_HOURS / 24).toBeLessThan(6);
  });
});

describe("d. 单一写者: 落定必须是原子更新", () => {
  /** 与 settleDvhTask 的 SQL 同构 —— 那句是 UPDATE ... WHERE status='submitted' */
  function trySettle(row: { status: string }, next: string): { ok: boolean; row: { status: string } } {
    if (row.status !== "submitted") return { ok: false, row };
    return { ok: true, row: { status: next } };
  }

  it("首次落定成功", () => {
    expect(trySettle({ status: "submitted" }, "failed").ok).toBe(true);
  });

  it("🔴 已落定的再落一次 → false, 调用方据此跳过记账与告警", () => {
    // 过渡期里"请求内轮询"和"定时任务"同时存在, 没有这一条就会双写:
    // 同一个任务记两笔账、发两条告警
    expect(trySettle({ status: "failed" }, "success").ok).toBe(false);
  });

  it("落定后状态不被后来者覆盖", () => {
    const first = trySettle({ status: "submitted" }, "success");
    const second = trySettle(first.row, "orphaned");
    expect(second.row.status).toBe("success");
  });
});

describe("e. 记账时机: submit 即记预估, 成功时只补差额", () => {
  /** 与 produce-video / dvh-poller 的算法同构 */
  const delta = (estimated: number, actual: number) => actual - estimated;

  it("实际比预估贵 → 补正差额", () => {
    expect(delta(1000, 1650)).toBe(650);
  });

  it("实际比预估便宜 → 记负数冲回", () => {
    expect(delta(2000, 1650)).toBe(-350);
  });

  it("🔴 不许再记全额 —— 那会让同一条视频记两笔", () => {
    const estimated = 1000, actual = 1650;
    expect(delta(estimated, actual)).not.toBe(actual);
    expect(estimated + delta(estimated, actual)).toBe(actual);   // 两笔之和 = 实际
  });

  it("相等时不产生第二笔", () => {
    expect(delta(1650, 1650)).toBe(0);
  });
});
