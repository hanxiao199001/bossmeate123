import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 7-27 质检退化的可观测性 —— 昨天新建的告警体系(ops_incidents)漏掉的那一类。
 *
 * 当天实况: 六维质检 LLM 60s 超时, 25 条内容里 20 条评分为 0 → 被红线剔除、零进草稿箱;
 *   AI 侧 49 次 "This operation was aborted"。ops_incidents **一条都没有**, 全靠人肉翻日志。
 *
 * 本测试锁三件事:
 *   ① 事件类型能区分 timeout(AI 没响应) vs degraded(响应了但评分不可用)
 *   ② 高频失败点的节流(10 分钟一条 + 带上被压掉的次数), 低频点不节流
 *   ③ 简报把条数翻译成运营看得懂的归因("今日有 N 条内容因质检超时没进草稿箱")
 */

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const insertValuesSpy = vi.fn();
vi.mock("../models/db.js", () => ({
  db: {
    insert: () => ({ values: (v: unknown) => { insertValuesSpy(v); return Promise.resolve(undefined); } }),
  },
}));
vi.mock("../models/schema.js", () => ({ opsIncidents: { kind: "kind", createdAt: "created_at", message: "message" } }));
vi.mock("drizzle-orm", () => ({ and: () => "and", desc: () => "desc", gte: () => "gte", sql: () => "sql" }));

const {
  recordIncident,
  recordIncidentThrottled,
  __resetIncidentThrottle,
  isTimeoutLikeError,
  isQuotaLikeError,
  KIND_LABEL,
  INCIDENT_THROTTLE_MS,
} = await import("../services/ops/incidents.js");

const { classifyQualityFailure } = await import("../services/content-engine/quality-check-v2.js");
const { judgePlatform, QUALITY_FAIL_ALERT_COUNT } = await import("../services/ops/daily-briefing.js");

beforeEach(() => {
  insertValuesSpy.mockReset();
  __resetIncidentThrottle();
});

describe("① 超时识别 isTimeoutLikeError", () => {
  it("认得今天线上那句 'This operation was aborted'", () => {
    expect(isTimeoutLikeError(new Error("This operation was aborted"))).toBe(true);
  });
  it("认得 AbortError / timeout / ETIMEDOUT / 中文超时", () => {
    const e = new Error("x"); e.name = "AbortError";
    expect(isTimeoutLikeError(e)).toBe(true);
    expect(isTimeoutLikeError(new Error("Request timed out after 60000ms"))).toBe(true);
    expect(isTimeoutLikeError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTimeoutLikeError("调用超时")).toBe(true);
  });
  it("业务错误不算超时(避免稀释信号): 400/额度不足由别的 kind 覆盖", () => {
    expect(isTimeoutLikeError(new Error("API 400: invalid_request_error model not found"))).toBe(false);
    expect(isTimeoutLikeError(new Error("insufficient_quota"))).toBe(false);
    expect(isTimeoutLikeError(null)).toBe(false);
    // 额度类仍走 isQuotaLikeError, 两个判据互不重叠
    expect(isQuotaLikeError(402, "")).toBe(true);
  });
});

describe("② 质检失败归类: 没评上分 vs 评分不可用", () => {
  it("AI 兜底文案/超时 → timeout", () => {
    const e = new Error("AI 兜底文案(模型超时/主备全挂), 未评分");
    e.name = "QualityCheckAiUnavailable";
    expect(classifyQualityFailure(e)).toBe("timeout");
    expect(classifyQualityFailure(new Error("This operation was aborted"))).toBe("timeout");
  });
  it("输出解析不了 → degraded(模型有响应, 只是格式坏了)", () => {
    expect(classifyQualityFailure(new Error("六维评分输出无 JSON"))).toBe("degraded");
    expect(classifyQualityFailure(new SyntaxError("Unexpected token"))).toBe("degraded");
  });
  it("两类都有人话标签, 简报不会只显示原始 kind", () => {
    expect(KIND_LABEL.quality_check_timeout).toBeTruthy();
    expect(KIND_LABEL.quality_check_degraded).toBeTruthy();
    expect(KIND_LABEL.quality_check_unavailable).toContain("没评上分");
    expect(KIND_LABEL.llm_timeout).toBeTruthy();
    expect(KIND_LABEL.output_unhealthy).toBeTruthy();
  });
});

describe("③ 节流: 高频点压条数, 但不丢信息", () => {
  it("窗口内只落一条, 之后的被压掉", async () => {
    const r1 = await recordIncidentThrottled({ kind: "llm_timeout", message: "t1" });
    const r2 = await recordIncidentThrottled({ kind: "llm_timeout", message: "t2" });
    const r3 = await recordIncidentThrottled({ kind: "llm_timeout", message: "t3" });
    expect([r1.recorded, r2.recorded, r3.recorded]).toEqual([true, false, false]);
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
  });

  it("窗口过后再落一条, 并带上这期间被压掉的次数", async () => {
    vi.useFakeTimers();
    try {
      await recordIncidentThrottled({ kind: "llm_timeout", message: "t1" });
      await recordIncidentThrottled({ kind: "llm_timeout", message: "t2" });
      await recordIncidentThrottled({ kind: "llm_timeout", message: "t3" });
      vi.advanceTimersByTime(INCIDENT_THROTTLE_MS + 1000);
      const r = await recordIncidentThrottled({ kind: "llm_timeout", message: "t4" });
      expect(r.recorded).toBe(true);
      expect(insertValuesSpy).toHaveBeenCalledTimes(2);
      const second = insertValuesSpy.mock.calls[1][0] as { detail: Record<string, unknown> };
      expect(second.detail.suppressedSinceLastAlert).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("不同 key(不同模型)各自节流, 互不遮蔽", async () => {
    await recordIncidentThrottled({ kind: "llm_timeout", message: "a" }, { key: "llm_timeout:deepseek:v4-pro" });
    await recordIncidentThrottled({ kind: "llm_timeout", message: "b" }, { key: "llm_timeout:qwen:plus" });
    expect(insertValuesSpy).toHaveBeenCalledTimes(2);
  });

  it("质检失败**不节流** —— 条数就是'今天有几篇没进草稿箱'", async () => {
    for (let i = 0; i < 5; i++) {
      await recordIncident({ kind: "quality_check_timeout", message: `第${i}篇` });
    }
    expect(insertValuesSpy).toHaveBeenCalledTimes(5);
  });
});

describe("④ 每日简报: 把条数翻译成归因", () => {
  const OK_SUPPLIER = {
    aliyunAvailableYuan: null, aliyunCurrency: null, aliyunError: null,
    avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0,
    level: "ok" as const, reasons: [] as string[],
  };
  const base = { health: { status: "ok" as const, timestamp: "", checks: {} }, supplier: OK_SUPPLIER };

  // 7-27 无人值守收口: 简报归因三态语义修正(timeout=过程量, 随后自动降级重评; "进不了草稿箱"
  // 只属于 quality_check_unavailable)。断言跟进 daily-briefing.judgePlatform 新行为
  // (返回 { items, todos }; timeout 大量=warn/少量=info), 归因细节测试在 ops-daily-briefing.test.ts。

  it("质检超时 20 次(今天的量级) → warn + 说明已自动降级重评, 不再错喊'进不了草稿箱'", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "quality_check_timeout", count: 20, lastMessage: "六维质检未评上分", lastAt: new Date() }],
    });
    expect(items[0]!.level).toBe("warn");
    expect(items[0]!.text).toContain("20 篇");
    expect(items[0]!.text).toContain("换快模型重评");
    expect(items[0]!.text).toContain("AI_QUALITY_CHECK_TIMEOUT_MS");
    expect(items[0]!.text).not.toContain("进不了草稿箱");
  });

  it("质检超时 1 次 → info(过程量, 偶发不吓人)", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "quality_check_timeout", count: 1, lastMessage: "x", lastAt: new Date() }],
    });
    expect(items[0]!.level).toBe("info");
    expect(QUALITY_FAIL_ALERT_COUNT).toBe(5);
  });

  it("真正'进不了草稿箱'的是 quality_check_unavailable → 达阈值报红", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "quality_check_unavailable", count: 20, lastMessage: "主+降级均失败", lastAt: new Date() }],
    });
    expect(items[0]!.level).toBe("alert");
    expect(items[0]!.text).toContain("20 篇没评上分");
    expect(items[0]!.text).toContain("进不了草稿箱");
  });

  it("出稿健康闸拦截 → 一次也报红(差点把废稿发出去)", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "output_unhealthy", count: 1, lastMessage: "标题是系统兜底文案", lastAt: new Date() }],
    });
    expect(items[0]!.level).toBe("alert");
    expect(items[0]!.text).toContain("废稿");
  });

  it("AI 超时事件 → warn, 明说 count 是 10 分钟节流后的'波数'", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "llm_timeout", count: 3, lastMessage: "AI 调用超时/中断", lastAt: new Date() }],
    });
    expect(items[0]!.level).toBe("warn");
    expect(items[0]!.text).toContain("3 波");
  });
});
