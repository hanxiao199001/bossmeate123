import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 7-27 质检自愈 —— 降级重试 + "未评上分 ≠ 评了 0 分" 的行为锁定。
 *
 * 事故复盘: 六维质检是全系统唯一没有跨厂商兜底的 LLM 链路(路由表 quality_check 的
 * primary/fallback 都是 deepseek-v4-pro, 去重后等于没备选)。当天 v4-pro 60s 超时,
 * "原模型重打 1 次"还是超时 → 20/25 条内容评 0 分 → 被红线剔除 → 整天零进草稿箱。
 *
 * 本测试锁四件事:
 *   ① 主模型超时 → **立刻换快模型**(skillType=quality_check_fast), 不原地重打白烧钱
 *   ② 降级出的分带 scoredBy=fallback + scorerModel(落 metadata 供日后抽检, 不混进标定样本)
 *   ③ 输出解析失败(模型有响应) → 保留旧行为: 原模型重打 1 次
 *   ④ 主+降级都失败 → degraded=true(没评上分), 调用次数有上限, 绝不无限重试
 * 以及配套: 未评上分的内容在草稿分发的**红线判据外**(不剔除, 排队尾)。
 */

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const chatMock = vi.fn();
vi.mock("../services/ai/chat-service.js", () => ({ chat: (...a: unknown[]) => chatMock(...a) }));

vi.mock("../services/knowledge/knowledge-service.js", () => ({ semanticSearch: vi.fn(async () => []) }));

// 正文编造扫描(动态 import): 本测试不关心, 恒返回无命中
vi.mock("../services/compliance/content-check.js", () => ({ findBodyFabrication: () => [] }));

const recordIncidentSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../services/ops/incidents.js", () => ({
  recordIncident: (...a: unknown[]) => recordIncidentSpy(...a),
  recordIncidentThrottled: vi.fn(async () => ({ recorded: true })),
  isTimeoutLikeError: (err: unknown) => /abort|timeout|超时/i.test(String(err instanceof Error ? err.message : err)),
}));

const { sixDimQualityCheck } = await import("../services/content-engine/quality-check-v2.js");
const { AI_FALLBACK_UNAVAILABLE } = await import("../services/ai/fallback-messages.js");

const GOOD_JSON = JSON.stringify({
  topicHook: { score: 8, weakestSection: "开头", fixHint: "钩子再前置", justification: "钩子到位" },
  dataAccuracy: { score: 8, weakestSection: "全文", fixHint: "补密度", justification: "全文约1800字，硬数据11个" },
  structureDensity: { score: 8, weakestSection: "全文", fixHint: "x", justification: "y" },
  formatting: { score: 8, weakestSection: "全文", fixHint: "x", justification: "y" },
  practicality: { score: 8, weakestSection: "结尾", fixHint: "x", justification: "y" },
  originalityCompliance: { score: 8, weakestSection: "全文", fixHint: "x", justification: "y" },
});

const ok = (model: string) => ({ content: GOOD_JSON, model, provider: "test", inputTokens: 1, outputTokens: 1 });
const PARAMS = { tenantId: "t1", title: "北大核心期刊推荐: 管理学方向重点关注", body: "<p>正文内容。</p>", contentId: "c-1" };

// reportQualityIncident 是 void async 旁路(内含动态 import), 断言前等它真正落完
async function flushIncidents(expectedCalls: number): Promise<void> {
  await vi.waitFor(() => {
    expect(recordIncidentSpy.mock.calls.length).toBeGreaterThanOrEqual(expectedCalls);
  }, { timeout: 2000, interval: 10 });
}

beforeEach(() => {
  chatMock.mockReset();
  recordIncidentSpy.mockReset();
});

describe("① 主模型超时 → 直接换快模型重评(不原地重打)", () => {
  it("第 2 次调用走 quality_check_fast, 分数可用且标记 scoredBy=fallback", async () => {
    chatMock
      .mockRejectedValueOnce(new Error("This operation was aborted"))
      .mockResolvedValueOnce(ok("qwen-plus"));

    const r = await sixDimQualityCheck(PARAMS);

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect((chatMock.mock.calls[0][0] as { skillType: string }).skillType).toBe("quality_check");
    expect((chatMock.mock.calls[1][0] as { skillType: string }).skillType).toBe("quality_check_fast");
    expect(r.degraded).toBe(false);
    expect(r.totalScore).toBe(80);
    expect(r.passed).toBe(true);
    expect(r.scoredBy).toBe("fallback");
    expect(r.scorerModel).toBe("qwen-plus");

    await flushIncidents(2);
    const kinds = recordIncidentSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("quality_check_timeout");   // 主模型超时本身就要报
    expect(kinds).toContain("quality_check_degraded");  // 分是降级模型给的, 供抽检
    expect(kinds).not.toContain("quality_check_unavailable");
  });

  it("chat() 主备全挂返回兜底文案(不抛错) → 识别为 AI 不可用, 同样转快模型", async () => {
    chatMock
      .mockResolvedValueOnce({ content: AI_FALLBACK_UNAVAILABLE, model: "deepseek-v4-pro", provider: "deepseek", inputTokens: 0, outputTokens: 0 })
      .mockResolvedValueOnce(ok("qwen-plus"));

    const r = await sixDimQualityCheck(PARAMS);
    expect(r.scoredBy).toBe("fallback");
    expect((chatMock.mock.calls[1][0] as { skillType: string }).skillType).toBe("quality_check_fast");
  });
});

describe("② 输出解析失败(模型有响应) → 保留原模型重打 1 次", () => {
  it("第 2 次仍走 quality_check, 成功后 scoredBy=primary", async () => {
    chatMock
      .mockResolvedValueOnce({ content: "对不起这不是 JSON", model: "deepseek-v4-pro", provider: "deepseek", inputTokens: 1, outputTokens: 1 })
      .mockResolvedValueOnce(ok("deepseek-v4-pro"));

    const r = await sixDimQualityCheck(PARAMS);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect((chatMock.mock.calls[1][0] as { skillType: string }).skillType).toBe("quality_check");
    expect(r.scoredBy).toBe("primary");
    expect(r.degraded).toBe(false);

    // 旁路是 fire-and-forget: 等一拍再确认确实没有任何 incident
    await new Promise((r) => setTimeout(r, 50));
    const kinds = recordIncidentSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual([]); // 主模型自己救回来了, 不算降级
  });
});

describe("③ 主+降级都失败 → 没评上分(≠ 0 分), 有上限不无限烧钱", () => {
  it("超时链路: 2 次调用就停(主超时→快模型也挂), degraded=true + unavailable 事件", async () => {
    chatMock.mockRejectedValue(new Error("This operation was aborted"));

    const r = await sixDimQualityCheck(PARAMS);
    expect(chatMock).toHaveBeenCalledTimes(2); // primary 超时 → fallback 失败 → 停手
    expect(r.degraded).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.scoredBy).toBeUndefined();       // 没评上分, 谈不上"谁给的分"
    expect(r.degradedReason).toContain("超时");

    await flushIncidents(2);
    const kinds = recordIncidentSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("quality_check_unavailable");
    // 每篇只报一条超时, 不按 attempt 刷屏
    expect(kinds.filter((k) => k === "quality_check_timeout")).toHaveLength(1);
  });

  it("解析失败链路: 至多 3 次调用(原模型重打 1 次 + 快模型 1 次)", async () => {
    chatMock.mockResolvedValue({ content: "不是 JSON", model: "m", provider: "p", inputTokens: 1, outputTokens: 1 });

    const r = await sixDimQualityCheck(PARAMS);
    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain("解析");
  });
});

describe("④ 未评上分不判红线(草稿分发准入判据)", () => {
  it("quality_check_unavailable / 旧名 sixdim_degraded → 允许进池; 红线类/废稿 → 剔除", async () => {
    // draft-distributor 依赖 db/env 等, 这里只 import 纯判据(见下方 mock 链)
    const { passesReasonGate, RED_LINE_REASONS, UNSCORED_REASONS } = await import("../services/publisher/draft-distributor.js");

    // generated 无条件过 reason 闸(但仍要过出稿健康闸 —— 那是另一道, 见 output-health-gate.test)
    expect(passesReasonGate("generated", undefined)).toBe(true);
    // "没评上分"不是信任事故: 进池(排队尾由 UNSCORED_REASONS 判定)
    expect(passesReasonGate("needs_review", "quality_check_unavailable")).toBe(true);
    expect(passesReasonGate("needs_review", "sixdim_degraded")).toBe(true);
    expect(UNSCORED_REASONS.has("quality_check_unavailable")).toBe(true);
    expect(UNSCORED_REASONS.has("sixdim_degraded")).toBe(true);
    // 六维分低(无特定 reason)也进池 —— 草稿箱是人工筛选台
    expect(passesReasonGate("needs_review", undefined)).toBe(true);
    // 红线与废稿永不进池
    for (const red of RED_LINE_REASONS) {
      expect(passesReasonGate("needs_review", red)).toBe(false);
    }
    expect(RED_LINE_REASONS).toContain("output_unhealthy");
    // "未评上分"绝不能出现在红线名单里 —— 7-27 零产出的直接死因
    expect(RED_LINE_REASONS).not.toContain("quality_check_unavailable");
    expect(RED_LINE_REASONS).not.toContain("sixdim_degraded");
  });
});

// ---- draft-distributor 的重依赖全部 mock 掉(本测试只用它的纯判据) ----
vi.mock("../models/db.js", () => ({ db: {} }));
vi.mock("../models/schema.js", () => ({ contents: {}, contentPublishLog: {}, platformAccounts: {}, tenants: {} }));
vi.mock("../config/system-recommendation.js", () => ({ SYSTEM_RECOMMENDATION_TENANT_ID: "00000000-0000-0000-0000-000000000000" }));
vi.mock("../config/env.js", () => ({ env: { DRAFT_PUSH_PER_ACCOUNT: 3, DRAFT_TARGET_PER_ACCOUNT: 2 } }));
vi.mock("../services/publisher/smart-assign.js", () => ({ computeSmartPairs: vi.fn() }));
vi.mock("../services/publisher/index.js", () => ({ publishToAccounts: vi.fn() }));
