import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 7-28 第一梯队② —— 堵 fail-open。
 *
 * 三处"坏了还在出货"的默认值:
 *   2a 红线校验 JSON 解析失败/异常 → `{passed:true}` 直接放行(**红线是最高级别检查, 判合格是最坏默认值**)
 *   2b chat() 主备全挂不抛异常, 返回中文道歉文案当 content(28 个调用点只有 3 个检查这个文案)
 *   2c safeSearch 挂掉返回 [] → 红线/风格/平台**三道检查同时空转**(7-25「三道闸同源」的新同构点)
 *
 * 本测试锁的核心不变量(与 7-27「0 分 ≠ 未评分」完全同构):
 *   **"检查不可用" 必须与 "内容违规" 分开** —— 前者转人工复核, 后者才是红线剔除。
 *   混成一个 boolean 会二选一地翻车: 判 true 坏了还出货, 判 false 则检查器一抖全部内容被打死。
 */

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// ---- chat-service: 只替换 chat(), isAiUnavailableError 用真实实现(判据不能各写一套) ----
const chatMock = vi.fn();
class FakeAiUnavailable extends Error {
  constructor() { super("AI 不可用: 主备模型全部调用失败 [x/y]"); this.name = "AiUnavailableError"; }
}
vi.mock("../services/ai/chat-service.js", () => ({
  chat: (...a: unknown[]) => chatMock(...a),
  isAiUnavailableError: (err: unknown) => err instanceof Error && err.name === "AiUnavailableError",
}));

const searchMock = vi.fn(async () => [] as Array<{ content: string }>);
vi.mock("../services/knowledge/knowledge-service.js", () => ({ semanticSearch: (...a: unknown[]) => searchMock(...(a as [])) }));

vi.mock("../services/compliance/content-check.js", () => ({ findBodyFabrication: () => [] }));

const recordIncidentSpy = vi.fn(async (..._a: unknown[]) => undefined);
const throttledSpy = vi.fn(async (..._a: unknown[]) => ({ recorded: true }));
vi.mock("../services/ops/incidents.js", () => ({
  recordIncident: (...a: unknown[]) => recordIncidentSpy(...a),
  recordIncidentThrottled: (...a: unknown[]) => throttledSpy(...a),
  isTimeoutLikeError: () => false,
}));

const { qualityCheckV2, classifyQualityFailure, QUALITY_GATE_UNAVAILABLE_REASON } =
  await import("../services/content-engine/quality-check-v2.js");

const SIX_DIM_OK = JSON.stringify({
  topicHook: { score: 9, weakestSection: "开头", fixHint: "-", justification: "-" },
  dataAccuracy: { score: 9, weakestSection: "全文", fixHint: "-", justification: "全文约1800字，硬数据11个" },
  structureDensity: { score: 8, weakestSection: "全文", fixHint: "-", justification: "-" },
  formatting: { score: 8, weakestSection: "全文", fixHint: "-", justification: "-" },
  practicality: { score: 9, weakestSection: "结尾", fixHint: "-", justification: "-" },
  originalityCompliance: { score: 9, weakestSection: "全文", fixHint: "-", justification: "-" },
});
const resp = (content: string) => ({ content, model: "m", provider: "p", inputTokens: 1, outputTokens: 1, ok: true });

/** 按 conversationId 分派: 六维恒过, 其余三道检查由各用例指定 */
function routeChat(handlers: { redline?: () => unknown; style?: () => unknown; platform?: () => unknown }) {
  chatMock.mockImplementation(async (req: { conversationId: string }) => {
    if (req.conversationId === "quality-score-sixdim") return resp(SIX_DIM_OK);
    if (req.conversationId === "quality-redline") return handlers.redline?.() ?? resp(`{"violations":[]}`);
    if (req.conversationId === "quality-style") return handlers.style?.() ?? resp(`{"consistency":90,"deviations":[]}`);
    if (req.conversationId === "quality-platform") return handlers.platform?.() ?? resp(`{"passed":true,"issues":[]}`);
    return resp("{}");
  });
}

const PARAMS = { tenantId: "t1", title: "北大核心期刊投稿指南", body: "<p>" + "正文内容。".repeat(60) + "</p>" };

beforeEach(() => {
  chatMock.mockReset();
  searchMock.mockReset();
  recordIncidentSpy.mockReset();
  throttledSpy.mockReset();
  searchMock.mockResolvedValue([{ content: "禁止承诺 100% 录用" }]);
});

describe("2a 红线校验: 解析失败/异常 → 判「检查不可用」而不是「合格」", () => {
  it("AI 输出不是 JSON → available=false(reason=parse_failed), overallPassed=false", async () => {
    routeChat({ redline: () => resp("我无法完成这个请求") });
    const r = await qualityCheckV2(PARAMS);

    expect(r.redlineCheck.available).toBe(false);
    expect(r.redlineCheck.unavailableReason).toBe("parse_failed");
    // ⚠️ 核心: 不能顺手把它判成"违规" —— violations 必须是空的, passed 保持"没查出违规"的语义
    expect(r.redlineCheck.violations).toEqual([]);
    expect(r.redlineCheck.passed).toBe(true);
    // 但综合判定必须为 false(不能放行)
    expect(r.overallPassed).toBe(false);
    expect(r.unavailableChecks).toContainEqual({ check: "redline", reason: "parse_failed" });
  });

  it("chat 抛异常(AI 主备全挂) → available=false(reason=ai_unavailable)", async () => {
    routeChat({ redline: () => { throw new FakeAiUnavailable(); } });
    const r = await qualityCheckV2(PARAMS);
    expect(r.redlineCheck.available).toBe(false);
    expect(r.redlineCheck.unavailableReason).toBe("ai_unavailable");
    expect(r.overallPassed).toBe(false);
  });

  it("JSON.parse 崩(半截 JSON) → 不再 `{passed:true}` 静默放行", async () => {
    routeChat({ redline: () => resp(`{"violations":[{"rule":`) });
    const r = await qualityCheckV2(PARAMS);
    expect(r.redlineCheck.available).toBe(false);
    expect(r.overallPassed).toBe(false);
  });

  it("反例(零回归): 真查出 critical 违规 → passed=false 且 available=true —— 这才是「违规」", async () => {
    routeChat({ redline: () => resp(`{"violations":[{"rule":"禁止保录","snippet":"100%录用","severity":"critical"}]}`) });
    const r = await qualityCheckV2(PARAMS);
    expect(r.redlineCheck.available).toBe(true);   // 检查跑成了
    expect(r.redlineCheck.passed).toBe(false);      // 结论是违规
    expect(r.unavailableChecks).toHaveLength(0);    // 不是"没检查成"
    expect(r.overallPassed).toBe(false);
  });

  it("反例(零回归): 一切正常 → overallPassed=true, 不产生任何『不可用』标记", async () => {
    routeChat({});
    const r = await qualityCheckV2(PARAMS);
    expect(r.unavailableChecks).toHaveLength(0);
    expect(r.redlineCheck.available).toBe(true);
    expect(r.overallPassed).toBe(true);
  });
});

describe("2c safeSearch 挂掉: 三道检查不能同时空转", () => {
  it("检索**异常** → 三道全部 available=false, overallPassed=false", async () => {
    searchMock.mockRejectedValue(new Error("vector store down"));
    routeChat({});
    const r = await qualityCheckV2({ ...PARAMS, platform: "wechat" });

    expect(r.redlineCheck.available).toBe(false);
    expect(r.styleCheck.available).toBe(false);
    expect(r.platformCheck.available).toBe(false);
    expect(r.unavailableChecks.map((u) => u.check).sort()).toEqual(["platform", "redline", "style"]);
    expect(r.unavailableChecks.every((u) => u.reason === "rules_unavailable")).toBe(true);
    expect(r.overallPassed).toBe(false);
    // 检索都挂了就不该再去调 LLM 做这三道检查(白花钱); 只剩六维那一次
    const convs = chatMock.mock.calls.map((c) => (c[0] as { conversationId: string }).conversationId);
    expect(convs).toEqual(["quality-score-sixdim"]);
  });

  it("检索**成功但 0 条规则** → 维持原行为放行(没配规则是配置状态, 不是故障)", async () => {
    searchMock.mockResolvedValue([]);
    routeChat({});
    const r = await qualityCheckV2({ ...PARAMS, platform: "wechat" });

    expect(r.redlineCheck.available).toBe(true);
    expect(r.styleCheck.available).toBe(true);
    expect(r.platformCheck.available).toBe(true);
    expect(r.unavailableChecks).toHaveLength(0);
    // 关键: 不能把"空规则库"也判成不通过 —— 那是把堵 fail-open 做成 fail-shut, 全部租户一夜转人工
    expect(r.overallPassed).toBe(true);
  });

  it("风格挂掉不再硬返 75 分冒充合格: available=false, 且该项被移出综合判定", async () => {
    routeChat({ style: () => resp("模型胡言乱语没有 JSON") });
    const r = await qualityCheckV2(PARAMS);
    expect(r.styleCheck.available).toBe(false);
    expect(r.unavailableChecks).toContainEqual({ check: "style", reason: "parse_failed" });
    // 风格是修饰性维度(不是安全闸) → 单独挂掉不把内容打成不通过, 但会留下"没检查成"的痕迹 + 告警
    expect(r.overallPassed).toBe(true);
  });

  it("平台规则挂掉 → 与红线同级, 直接不放行(能不能发是安全问题)", async () => {
    routeChat({ platform: () => resp("no json here") });
    const r = await qualityCheckV2({ ...PARAMS, platform: "wechat" });
    expect(r.platformCheck.available).toBe(false);
    expect(r.platformCheck.passed).toBe(true); // 没查出问题 ≠ 合规
    expect(r.overallPassed).toBe(false);
  });
});

describe("「检查不可用」的对外表达: 告警 + 人话 + reason 常量", () => {
  it("落 ops_incidents(quality_gate_unavailable, 节流), 且措辞明说不是内容违规", async () => {
    routeChat({ redline: () => resp("坏输出") });
    await qualityCheckV2(PARAMS);
    await vi.waitFor(() => expect(throttledSpy).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
    const arg = throttledSpy.mock.calls[0]![0] as { kind: string; message: string };
    expect(arg.kind).toBe("quality_gate_unavailable");
    expect(arg.message).toContain("不是内容违规");
  });

  it("feedback 里『没检查成』与『违规』用词不混", async () => {
    routeChat({ redline: () => resp("坏输出") });
    const r = await qualityCheckV2(PARAMS);
    expect(r.feedback).toContain("未能完成");
    expect(r.feedback).toContain("不是内容违规");
    expect(r.feedback).not.toContain("红线违规");
  });

  it("转人工的 reason 常量与 draft-distributor 的判据同源(不是红线, 进池排队尾)", async () => {
    const dd = await import("../services/publisher/draft-distributor.js");
    expect(QUALITY_GATE_UNAVAILABLE_REASON).toBe("quality_gate_unavailable");
    expect(dd.GATE_UNAVAILABLE_REASONS.has(QUALITY_GATE_UNAVAILABLE_REASON)).toBe(true);
    expect(dd.TAIL_REASONS.has(QUALITY_GATE_UNAVAILABLE_REASON)).toBe(true);
    // ⚠️ 绝不能进红线名单 —— 那会让"检查器挂了"的内容被永久剔除出草稿箱(7-27 零产出事故的复刻)
    expect(dd.RED_LINE_REASONS).not.toContain(QUALITY_GATE_UNAVAILABLE_REASON);
    expect(dd.passesReasonGate("needs_review", QUALITY_GATE_UNAVAILABLE_REASON)).toBe(true);
  });
});

describe("2d batch-worker 的两处 open: 异常 ≠ 通过", () => {
  // batch-worker 的主体是 BullMQ worker 回调(强依赖队列/DB/skills, 单测跑不起来),
  // 这里锁"控制流形状"—— 这两处的病根就是 `catch {}` 后变量保持 null 而 null 被当通过。
  it(":269 质检流水线异常 → 不再静默(catch 里标 gateUnavailable, 并计入 failed 判定)", async () => {
    const { readFileSync } = await import("node:fs");
    const s = readFileSync(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    // 原来的 `catch (e) { logger.warn(...) }` 现在必须给 gateUnavailable 赋值
    expect(s).toMatch(/gateUnavailable = "quality_pipeline_error"/);
    // failed 判定必须把它算进去 —— 否则标了也白标
    expect(s).toMatch(/gateUnavailable !== null/);
  });

  it(":303 三道一致性检查 catch 后不再直接 generated", async () => {
    const { readFileSync } = await import("node:fs");
    const s = readFileSync(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    expect(s).toMatch(/gateUnavailable = gateUnavailable \?\? "consistency_check_error"/);
    // 旧的"吞异常"写法必须消失
    expect(s).not.toContain("catch { /* 一致性检查失败不阻塞生产 */ }");
  });

  it("转待审的 reason 是 quality_gate_unavailable(非红线) + 落 incident", async () => {
    const { readFileSync } = await import("node:fs");
    const s = readFileSync(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    expect(s).toMatch(/needsReviewReason: "quality_gate_unavailable"/);
    expect(s).toMatch(/kind: "quality_gate_unavailable"/);
    // 优先级: 查出来的问题(红线/编造) 仍排在"没检查成"前面, 不能被覆盖
    expect(s.indexOf("titleBodyBad.reason")).toBeLessThan(s.indexOf(`needsReviewReason: "quality_gate_unavailable"`));
  });
});

describe("2b chat() 主备全挂: 归类为「AI 没给出内容」而不是「输出格式坏了」", () => {
  it("AiUnavailableError → classifyQualityFailure=timeout(靠类型判, 不靠错误文案)", () => {
    expect(classifyQualityFailure(new FakeAiUnavailable())).toBe("timeout");
    // 反例: 真的是输出解析问题 → degraded
    expect(classifyQualityFailure(new Error("六维评分输出无 JSON"))).toBe("degraded");
  });
});

// ---- draft-distributor 的重依赖(本测试只用它的纯判据) ----
vi.mock("../models/db.js", () => ({ db: {} }));
vi.mock("../models/schema.js", () => ({ contents: {}, contentPublishLog: {}, platformAccounts: {}, tenants: {} }));
vi.mock("../config/system-recommendation.js", () => ({ SYSTEM_RECOMMENDATION_TENANT_ID: "00000000-0000-0000-0000-000000000000" }));
vi.mock("../config/env.js", () => ({
  env: {
    DRAFT_PUSH_PER_ACCOUNT: 3, DRAFT_TARGET_PER_ACCOUNT: 2,
    DRAFT_SHORTFALL_REMEDY_ENABLED: true, DRAFT_SHORTFALL_REMEDY_WINDOW_DAYS: 21,
  },
}));
vi.mock("../services/publisher/smart-assign.js", () => ({ computeSmartPairs: vi.fn() }));
vi.mock("../services/publisher/index.js", () => ({ publishToAccounts: vi.fn() }));
