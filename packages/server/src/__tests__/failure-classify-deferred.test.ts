import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 8-03 失败分类 + deferred 标记 + 探测退避。
 *
 * 【当天实况】阿里云百炼欠费, 真实报文:
 *   HTTP 400 {"type":"Arrearage","message":"Access denied, please make sure your account
 *             is in good standing before making a request."}
 *   - isQuotaLikeError 对着这条**返回 false**(词表写的是 "arrears", 报文是 "Arrearage",
 *     差一个词形; 而且只有 402 直接判 true, 这条是 400) → llm_quota 一条都没记;
 *   - 质检主备模型同时失败(共用一个阿里云账户) → 9 篇判 needs_review 卡住, 没人知道要重跑;
 *   - 老板在"文字稿直生"写的 157 字口播稿, TTS 失败硬中止 → 不落库不产视频, 稿子丢了。
 *
 * 本测试锁五件事:
 *   ① 那条真实报文必须被认出来(字段优先, 文本兜底), 且不能误伤正常的 400 参数错误
 *   ② 三分类判据表(quota / service_down / content_error)
 *   ③ deferred 的 input **完整性** —— 漏一个字段这条内容就永远重跑不回来
 *   ④ retryCount 上限(别让一条永远坏的内容每 30 分钟烧一次钱)
 *   ⑤ 探测退避(欠费期间不能持续烧探测费)
 */

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {} }));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id", metadata: "metadata", tenantId: "tenant_id", updatedAt: "updated_at" },
  opsIncidents: { kind: "kind", createdAt: "created_at", message: "message" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (x: unknown) => x,
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  inArray: (a: unknown, b: unknown) => [a, b],
  sql: (...a: unknown[]) => a,
}));

const {
  isQuotaLikeError,
  isTimeoutLikeError,
  classifyFailure,
  isRetriableFailure,
  parseProviderErrorBody,
  extractErrorFields,
} = await import("../services/ops/failure-kind.js");

const {
  buildDeferred,
  readDeferred,
  canAutoRetry,
  describeDeferred,
  describeFailureDetail,
  DEFERRED_MAX_RETRY,
} = await import("../services/ops/deferred.js");

const { nextProbeIntervalMs, shouldProbeNow, __resetProbeState, PROBE_BASE_INTERVAL_MS, PROBE_MAX_INTERVAL_MS } =
  await import("../services/ops/service-health-probe.js");

// ══════════ 8-03 那条真实报文(整个测试文件的样本) ══════════
const ARREARAGE_BODY =
  '{"type":"Arrearage","message":"Access denied, please make sure your account is in good standing before making a request."}';

/** 还原线上抛出来的那个 Error: provider 层会把 status/errorType 挂成字段(8-03 起) */
function arrearageError(): Error {
  const e = new Error(`qwen API 错误: 400 - ${ARREARAGE_BODY}`) as Error & {
    status?: number; errorType?: string; responseBody?: string;
  };
  e.status = 400;
  e.errorType = "Arrearage";
  e.responseBody = ARREARAGE_BODY;
  return e;
}

beforeEach(() => {
  __resetProbeState();
});

describe("① 8-03 真实欠费报文必须被认出来", () => {
  it("🔴 回归: HTTP 400 + type=Arrearage(结构化字段) → 账户级", () => {
    expect(isQuotaLikeError(400, ARREARAGE_BODY, { errorType: "Arrearage" })).toBe(true);
  });

  it("🔴 回归: 就算没挂字段, 光靠报文也认得出(旧词表只有 arrears, 对着 Arrearage 返回 false)", () => {
    expect(isQuotaLikeError(400, ARREARAGE_BODY)).toBe(true);
  });

  it("报文里的 type 能被解析成结构化字段", () => {
    expect(parseProviderErrorBody(ARREARAGE_BODY)).toMatchObject({ type: "Arrearage" });
    // OpenAI 兼容的嵌套形态也认
    expect(parseProviderErrorBody('{"error":{"type":"insufficient_quota","code":"x"}}'))
      .toMatchObject({ type: "insufficient_quota", code: "x" });
    // 不是 JSON 一律返回空对象, 绝不抛
    expect(parseProviderErrorBody("<html>502 Bad Gateway</html>")).toEqual({});
    expect(parseProviderErrorBody(null)).toEqual({});
  });

  it("从 Error 上能抠回 status / errorType(字段优先), 也能从中文文案里兜底抠出状态码", () => {
    expect(extractErrorFields(arrearageError())).toMatchObject({ status: 400, errorType: "Arrearage" });
    // 老调用点只有文案, 没有字段
    expect(extractErrorFields(new Error("deepseek API 错误: 503 - upstream down"))).toMatchObject({ status: 503 });
  });

  it("新增的四个词形都认: arrearage / overdue / good standing / access denied", () => {
    expect(isQuotaLikeError(400, "Arrearage")).toBe(true);
    expect(isQuotaLikeError(400, "your account is overdue")).toBe(true);
    expect(isQuotaLikeError(400, "make sure your account is in good standing")).toBe(true);
    expect(isQuotaLikeError(400, "Access denied, please recharge")).toBe(true);
  });

  it("旧判据一个都不能丢(402 / insufficient_quota / 中文欠费 …)", () => {
    expect(isQuotaLikeError(402, "")).toBe(true);
    expect(isQuotaLikeError(429, "insufficient_quota")).toBe(true);
    expect(isQuotaLikeError(400, "AllocationQuota exceeded")).toBe(true);
    expect(isQuotaLikeError(500, "账户余额不足")).toBe(true);
    expect(isQuotaLikeError(403, "AccessDenied.Unpurchased")).toBe(true);
  });

  it("不误伤: 400 的**请求级** type(参数错/内容安全)不是欠费", () => {
    expect(isQuotaLikeError(400, '{"error":{"type":"invalid_request_error","message":"bad param"}}')).toBe(false);
    expect(isQuotaLikeError(400, '{"code":"DataInspectionFailed","message":"content filtered"}')).toBe(false);
  });

  it("不误伤: 401/403 的 'access denied' 是 key 配错, 不是欠费(充值也救不了)", () => {
    expect(isQuotaLikeError(401, "Access denied: invalid api key")).toBe(false);
    expect(isQuotaLikeError(403, "access denied")).toBe(false);
  });

  it("超时判据保持原样(7-27 那条线上原话)", () => {
    expect(isTimeoutLikeError(new Error("This operation was aborted"))).toBe(true);
    expect(isTimeoutLikeError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTimeoutLikeError(null)).toBe(false);
  });
});

describe("② 三分类判据表 classifyFailure", () => {
  it("quota_exceeded: 8-03 那条真实报文", () => {
    expect(classifyFailure(arrearageError())).toBe("quota_exceeded");
  });

  it("quota_exceeded: 402 / insufficient / 中文额度用完 / 我们自己的花费闸", () => {
    const e402 = Object.assign(new Error("payment required"), { status: 402 });
    expect(classifyFailure(e402)).toBe("quota_exceeded");
    expect(classifyFailure(new Error("insufficient_quota"))).toBe("quota_exceeded");
    expect(classifyFailure(new Error("qwen API 错误: 400 - 额度不足"))).toBe("quota_exceeded");
    expect(classifyFailure(new Error("BUDGET_EXCEEDED: 本月预算已用尽"))).toBe("quota_exceeded");
  });

  it("service_down: 超时 / aborted / ECONNRESET / 5xx / 连接失败 / AI 主备全挂", () => {
    expect(classifyFailure(new Error("This operation was aborted"))).toBe("service_down");
    expect(classifyFailure(new Error("Request timed out after 60000ms"))).toBe("service_down");
    expect(classifyFailure(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe("service_down");
    expect(classifyFailure(Object.assign(new Error("bad gateway"), { status: 502 }))).toBe("service_down");
    expect(classifyFailure(new Error("fetch failed"))).toBe("service_down");
    const ai = new Error("AI 不可用: 主备模型全部调用失败"); ai.name = "AiUnavailableError";
    expect(classifyFailure(ai)).toBe("service_down");
  });

  it("service_down: 429 限流 = 此刻不可用(退避后原样可跑), 但不算欠费", () => {
    expect(classifyFailure(Object.assign(new Error("rate limit"), { status: 429 }))).toBe("service_down");
    expect(isQuotaLikeError(429, "Requests per minute exceeded")).toBe(false);
  });

  it("service_down: DVH 的 TTS 硬中止; 若 TTS 真因是欠费则升级为 quota_exceeded", () => {
    const tts = new Error("DVH_TTS_FAILED: TTS 合成失败降级为静音"); tts.name = "DvhTtsFailedError";
    expect(classifyFailure(tts)).toBe("service_down");
    // 8-03 真实链路: qwen-tts 报 Arrearage → 原因经 cause 一路带上来
    const ttsQuota = new Error("DVH_TTS_FAILED: TTS 合成失败降级为静音");
    ttsQuota.name = "DvhTtsFailedError";
    (ttsQuota as Error & { cause?: unknown }).cause = new Error(`Error: qwen-tts 400 ${ARREARAGE_BODY}`);
    expect(classifyFailure(ttsQuota)).toBe("quota_exceeded");
  });

  it("content_error: JSON 解析失败 / 校验不过 / 400 参数错 —— 重跑也没用", () => {
    expect(classifyFailure(new SyntaxError("Unexpected token < in JSON at position 0"))).toBe("content_error");
    expect(classifyFailure(new Error("正文为空, 校验不通过"))).toBe("content_error");
    expect(classifyFailure(Object.assign(new Error("bad request"), { status: 400, errorType: "invalid_request_error" })))
      .toBe("content_error");
    expect(classifyFailure(undefined)).toBe("content_error");
  });

  it("只有前两类能自动重跑, content_error 判死", () => {
    expect(isRetriableFailure("quota_exceeded")).toBe(true);
    expect(isRetriableFailure("service_down")).toBe(true);
    expect(isRetriableFailure("content_error")).toBe(false);
  });

  it("话术能说到点上(运营看的是这句)", () => {
    expect(describeFailureDetail(arrearageError())).toContain("欠费");
    expect(describeFailureDetail(new Error("This operation was aborted"))).toContain("超时");
    expect(describeFailureDetail(new SyntaxError("bad json"))).toContain("内容本身");
  });
});

describe("③ deferred 的 input 完整性 —— 漏一个字段这条就永远跑不回来", () => {
  it("文字稿直生: 口播稿原文 + 形象/音色/背景 一个都不能少(老板那条 157 字就是这么丢的)", () => {
    const text = "各位老师好，今天聊聊 SCI 投稿被拒后怎么改。".repeat(6);
    const mark = buildDeferred({
      err: arrearageError(),
      input: {
        kind: "dvh_text",
        tenantId: "t1", userId: "u1",
        text, title: "投稿被拒怎么改",
        templateId: "A_academic", voiceId: "zhixiaobai", backgroundUrl: "https://x/bg.png",
        conversationId: "c1",
      },
    });
    expect(mark).not.toBeNull();
    expect(mark!.reason).toBe("quota_exceeded");
    // 重跑要用的东西必须原样在
    expect(mark!.input).toMatchObject({
      kind: "dvh_text", text, title: "投稿被拒怎么改",
      templateId: "A_academic", voiceId: "zhixiaobai", backgroundUrl: "https://x/bg.png",
    });
    expect((mark!.input as { text: string }).text).toBe(text); // 原文一字不改
  });

  it("文章生成: batchId/batchRowId(重新入队用) + topic/journalId/template 快照", () => {
    const mark = buildDeferred({
      err: new Error("This operation was aborted"),
      input: {
        kind: "article_generation",
        batchId: "b1", batchRowId: "r1", tenantId: "t1", userId: "u1",
        topic: "如何提高 SCI 命中率", template: "A", journalId: "j1", accountId: "a1",
      },
    });
    expect(mark!.reason).toBe("service_down");
    expect(mark!.input).toMatchObject({ batchId: "b1", batchRowId: "r1", topic: "如何提高 SCI 命中率", journalId: "j1" });
  });

  it("质检: contentId 就够(正文已落库)", () => {
    const mark = buildDeferred({
      err: arrearageError(),
      input: { kind: "quality_check", tenantId: "t1", contentId: "c9", journalId: "j2" },
    });
    expect(mark!.input).toMatchObject({ kind: "quality_check", contentId: "c9" });
  });

  it("content_error 不给 deferred —— 判死比假装能救回来诚实", () => {
    expect(buildDeferred({
      err: new SyntaxError("bad json"),
      input: { kind: "quality_check", tenantId: "t1", contentId: "c9" },
    })).toBeNull();
  });

  it("落库再读回来, input 不丢(readDeferred 是前端/探测器的唯一入口)", () => {
    const mark = buildDeferred({
      err: arrearageError(),
      input: { kind: "dvh_text", tenantId: "t1", userId: "u1", text: "稿子原文", templateId: "A_academic" },
    })!;
    const roundTrip = readDeferred(JSON.parse(JSON.stringify({ deferred: mark, other: 1 })));
    expect(roundTrip).not.toBeNull();
    expect((roundTrip!.input as { text: string }).text).toBe("稿子原文");
    // 形状不对一律当没有, 绝不抛
    expect(readDeferred(null)).toBeNull();
    expect(readDeferred({ deferred: { reason: "whatever" } })).toBeNull();
  });
});

describe("④ retryCount 上限 —— 别让一条永远坏的内容每 30 分钟烧一次钱", () => {
  const base = () => buildDeferred({
    err: arrearageError(),
    input: { kind: "quality_check", tenantId: "t1", contentId: "c1" },
  })!;

  it("上限是 5", () => {
    expect(DEFERRED_MAX_RETRY).toBe(5);
  });

  it("没到上限可跑, 到了就停", () => {
    expect(canAutoRetry({ ...base(), retryCount: 0 })).toBe(true);
    expect(canAutoRetry({ ...base(), retryCount: DEFERRED_MAX_RETRY - 1 })).toBe(true);
    expect(canAutoRetry({ ...base(), retryCount: DEFERRED_MAX_RETRY })).toBe(false);
    expect(canAutoRetry({ ...base(), retryCount: 99 })).toBe(false);
  });

  it("已标 exhausted / 已重新入队过的, 不再自动跑(否则一条稿子生一堆重复付费视频)", () => {
    expect(canAutoRetry({ ...base(), exhausted: true })).toBe(false);
    expect(canAutoRetry({ ...base(), requeuedAt: new Date().toISOString() })).toBe(false);
  });

  it("重跑失败时计数要能带过来(否则永远从 0 开始 = 上限形同虚设)", () => {
    const again = buildDeferred({
      err: arrearageError(),
      input: { kind: "quality_check", tenantId: "t1", contentId: "c1" },
      retryCount: 3,
    })!;
    expect(again.retryCount).toBe(3);
  });

  it("给运营的说法要分清'还会自己跑'和'该你上了'", () => {
    expect(describeDeferred({ ...base(), retryCount: 2 })).toContain("自动重跑");
    expect(describeDeferred({ ...base(), retryCount: 5, exhausted: true })).toContain("人工");
  });
});

describe("⑤ 探测退避 —— 欠费期间不能持续烧探测费", () => {
  it("刚挂时勤探(30 分钟), 连续失败逐步拉长, 封顶 2 小时", () => {
    expect(nextProbeIntervalMs(0)).toBe(PROBE_BASE_INTERVAL_MS);
    expect(nextProbeIntervalMs(1)).toBe(PROBE_BASE_INTERVAL_MS);
    expect(nextProbeIntervalMs(2)).toBe(60 * 60_000);
    expect(nextProbeIntervalMs(3)).toBe(PROBE_MAX_INTERVAL_MS);
    expect(nextProbeIntervalMs(10)).toBe(PROBE_MAX_INTERVAL_MS);
    // 单调不减 + 永不超过上限
    for (let n = 0; n < 20; n++) {
      expect(nextProbeIntervalMs(n)).toBeLessThanOrEqual(PROBE_MAX_INTERVAL_MS);
      expect(nextProbeIntervalMs(n + 1)).toBeGreaterThanOrEqual(nextProbeIntervalMs(n));
    }
  });

  it("首次一定探(没有历史 = 不该白等)", () => {
    expect(shouldProbeNow("llm", Date.now())).toBe(true);
  });
});
