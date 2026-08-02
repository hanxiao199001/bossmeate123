/**
 * 7-28 第一梯队① —— 目标闭环: 让"没达成"变成动作, 而不是一行日志。
 *
 * 审计结论: 系统已经算出了所有它需要知道的事(缺口/选不出刊/生成不足), 但**全部只送去给人看** ——
 *   老板不看简报, 这些数字等于不存在。daily-cron 里 17 个跳过点只有 1 个落了 ops_incidents。
 *
 * 本测试锁三件:
 *   ①a 关键跳过点(选不出刊/选不出题/生成失败/选刊降级)落 incident, 且高频点走节流
 *   ①b 产出不足分级: 零产出=🔴; 低于目标 60%=🟡(原来"目标 20 实际 1"完全静默)
 *   简报把这些 kind 翻成运营看得懂的人话 + 正确的严重度
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

vi.mock("drizzle-orm", () => {
  const tag = () => ({ __sql: true });
  return { and: tag, or: tag, eq: tag, gte: tag, lt: tag, inArray: tag, desc: tag, isNull: tag, sql: Object.assign(tag, { raw: tag, join: tag }) };
});

const TBL = {
  keywords: { __t: "keywords" }, contents: { __t: "contents" }, tenants: { __t: "tenants" },
  journals: { __t: "journals", id: "id" }, journalUsage: { __t: "journal_usage" }, platformAccounts: { __t: "accounts" },
};
vi.mock("../models/schema.js", () => TBL);
vi.mock("../config/env.js", () => ({ env: { DRAFT_TARGET_PER_ACCOUNT: 2, DRAFT_GEN_BUFFER: 1.3, DAILY_GEN_HARD_CAP: 40 } }));
vi.mock("../config/system-recommendation.js", () => ({
  SYSTEM_RECOMMENDATION_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  SYSTEM_RECOMMENDATION_USER_ID: "00000000-0000-0000-0000-000000000001",
}));
vi.mock("../services/recommendation/journal-scope.js", () => ({ journalScopeCondition: () => null }));
vi.mock("../services/articles/state-machine.js", () => ({ initialStatusFields: () => ({ status: "generated" }) }));
vi.mock("../services/recommendation/journal-recommender.js", () => ({ recommendJournals: vi.fn(async () => []) }));
vi.mock("../services/content-engine/roundup-generator.js", () => ({ generateRoundupArticle: vi.fn() }));

const createBatchMock = vi.fn(async () => ({ batchId: "b1" }));
vi.mock("../services/batch/batch-service.js", () => ({ createBatch: (...a: unknown[]) => createBatchMock(...(a as [])) }));

const recordIncidentSpy = vi.fn(async (..._a: unknown[]) => undefined);
const throttledSpy = vi.fn(async (..._a: unknown[]) => ({ recorded: true }));
// 只替换两个落库函数, KIND_LABEL 等常量用真实实现(简报渲染要读它, 不能各写一套)
vi.mock("../services/ops/incidents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ops/incidents.js")>()),
  recordIncident: (...a: unknown[]) => recordIncidentSpy(...a),
  recordIncidentThrottled: (...a: unknown[]) => throttledSpy(...a),
}));

// ---- db mock: 按 表 + 选中的列名 路由(journals 上有两种查询, 靠列名区分) ----
const S = {
  /** pickScopedFreshJournal 每一层 pick 的返回(null = 选不出刊) */
  journalId: null as string | null,
  /** classifyPickDegrade 看到的刊(学科码 + 上次使用时间) */
  journalRow: { disciplineCode: "medicine", lastUsedAt: null as Date | null },
  keywords: [{ id: "k1", keyword: "医学论文写作", category: "medicine" }],
};

function mkBuilder(cols: Record<string, unknown> | undefined) {
  let table = "";
  const self: Record<string, unknown> = {};
  for (const m of ["where", "orderBy", "limit", "groupBy", "innerJoin", "set", "values", "onConflictDoUpdate", "returning"]) {
    self[m] = () => self;
  }
  self.from = (t: { __t?: string }) => { table = t?.__t ?? ""; return self; };
  self.then = (res: (v: unknown) => void) => {
    const keys = Object.keys(cols ?? {});
    if (table === "journals") {
      // classifyPickDegrade 查的是 disciplineCode + lastUsedAt; 选刊层查的是 id
      if (keys.includes("disciplineCode")) return res([S.journalRow]);
      return res(S.journalId ? [{ id: S.journalId }] : []);
    }
    if (table === "journal_usage") return res([{ n: 0 }]);
    if (table === "keywords") return res(S.keywords);
    return res([]);
  };
  return self;
}
vi.mock("../models/db.js", () => ({
  db: {
    select: (cols?: Record<string, unknown>) => mkBuilder(cols),
    update: () => mkBuilder(undefined),
    insert: () => mkBuilder(undefined),
  },
}));

const { runDailyContentByType, LOW_OUTPUT_RATIO } = await import("../services/recommendation/daily-cron.js");
const { classifyPickDegrade, describePickDegrade } = await import("../services/recommendation/pick-degrade.js");
const { judgePlatform } = await import("../services/ops/daily-briefing.js");
const { KIND_LABEL } = await import("../services/ops/incidents.js");

const kindsOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
async function flush(spy: { mock: { calls: unknown[][] } }, n: number) {
  await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(n), { timeout: 2000, interval: 5 });
}

beforeEach(() => {
  recordIncidentSpy.mockReset();
  throttledSpy.mockReset();
  createBatchMock.mockReset();
  createBatchMock.mockResolvedValue({ batchId: "b1" });
  S.journalId = "j1";
  S.journalRow = { disciplineCode: "medicine", lastUsedAt: null };
});

describe("①a 排产跳过点落库(原来只有 logger 一行)", () => {
  it("选不出刊 → no_journal_available(节流, 带 定位+学科), 名额空转不再静默", async () => {
    S.journalId = null;
    const r = await runDailyContentByType({ domestic: { count: 2, disciplines: ["medicine"] } });

    expect(r.articlesEnqueued).toBe(0);
    await flush(throttledSpy, 1);
    const t = throttledSpy.mock.calls.map((c) => (c[0] as { kind: string }));
    expect(t.map((x) => x.kind)).toContain("no_journal_available");
    // 节流 key 必须按 定位+学科 分, 否则"国内医学没刊"会把"国外教育没刊"整个盖住
    const opts = throttledSpy.mock.calls.find((c) => (c[0] as { kind: string }).kind === "no_journal_available")![1] as { key: string };
    expect(opts.key).toContain("domestic");
    expect(opts.key).toContain("medicine");
  });

  it("生成失败 → generation_failed(节流), 而不是只 warn 一行", async () => {
    createBatchMock.mockRejectedValue(new Error("LLM 余额不足"));
    await runDailyContentByType({ domestic: { count: 2, disciplines: ["medicine"] } });

    await flush(throttledSpy, 1);
    const hit = throttledSpy.mock.calls.find((c) => (c[0] as { kind: string }).kind === "generation_failed");
    expect(hit).toBeTruthy();
    expect((hit![0] as { message: string }).message).toContain("LLM 余额不足");
  });

  it("选刊降级(回头刊/不对口) → journal_pool_exhausted: 「某学科刊快用完了」的直接证据", async () => {
    // 3 天前刚用过这本刊 → 破 15 天冷却 = 降到第⑤层以下
    S.journalRow = { disciplineCode: "medicine", lastUsedAt: new Date(Date.now() - 3 * 86_400_000) };
    await runDailyContentByType({ domestic: { count: 1, disciplines: ["medicine"] } });

    await flush(throttledSpy, 1);
    const hit = throttledSpy.mock.calls.find((c) => (c[0] as { kind: string }).kind === "journal_pool_exhausted");
    expect(hit).toBeTruthy();
    expect((hit![0] as { message: string }).message).toContain("接近枯竭");
  });

  it("反例(零回归): 新鲜且对口的刊 → 不报降级(否则天天刷屏, 告警会被忽略)", async () => {
    S.journalRow = { disciplineCode: "medicine", lastUsedAt: null };
    await runDailyContentByType({ domestic: { count: 1, disciplines: ["medicine"] } });
    await new Promise((r) => setTimeout(r, 60));
    expect(kindsOf(throttledSpy)).not.toContain("journal_pool_exhausted");
  });
});

describe("①b 产出不足分级: 零 = 🔴, 不足 60% = 🟡", () => {
  // ════ 8-02 断言翻转 ════
  // 这两条原来断言 runDailyContentByType 会落 zero_output / low_output。**已搬到简报侧**:
  //   它们此前建立在 totalProduced = batchIds.length = **入队数** 上(createBatch 只是 db.insert),
  //   真正的生成在下游 batch-worker 异步跑 —— 入队成功就报绿, 哪怕一篇没生出来。
  //   实测代价: 近 14 天 batch_rows 失败 416/成功 526, 而这两条 incident 一条都没落过。
  //   而且本函数 03:00 跑完时一篇都还没生成, 在这里判"产出"必然判的是意图不是结果。
  // 保护没丢, 搬到了 ops/generation-outcome.ts(按当天**实际生成的 contents 条数**判),
  //   单测见 generation-outcome.test.ts。这里只锁"daily-cron 不再落这两条"。
  it("8-02 已搬简报侧: daily-cron 零产出时**不再**落 zero_output(那是入队数不是产出数)", async () => {
    S.journalId = null;
    await runDailyContentByType({ domestic: { count: 4, disciplines: ["medicine"] } });
    expect(kindsOf(recordIncidentSpy)).not.toContain("zero_output");
  });

  it("8-02 已搬简报侧: 入队不足时**不再**落 low_output", async () => {
    createBatchMock
      .mockResolvedValueOnce({ batchId: "b1" })
      .mockRejectedValue(new Error("boom"));
    const r = await runDailyContentByType({ domestic: { count: 5, disciplines: ["medicine"] } });
    expect(r.articlesEnqueued).toBe(1);   // 返回值语义没动(调用方不受影响)
    expect(kindsOf(recordIncidentSpy)).not.toContain("low_output");
    expect(kindsOf(recordIncidentSpy)).not.toContain("zero_output");
  });

  it("达标(≥60%)不报警: 目标 5 出 4 → 什么都不落", async () => {
    createBatchMock
      .mockResolvedValueOnce({ batchId: "b1" }).mockResolvedValueOnce({ batchId: "b2" })
      .mockResolvedValueOnce({ batchId: "b3" }).mockResolvedValueOnce({ batchId: "b4" })
      .mockRejectedValue(new Error("boom"));
    await runDailyContentByType({ domestic: { count: 5, disciplines: ["medicine"] } });

    const kinds = kindsOf(recordIncidentSpy);
    expect(kinds).not.toContain("low_output");
    expect(kinds).not.toContain("zero_output");
    expect(LOW_OUTPUT_RATIO).toBe(0.6);
  });
});

describe("选刊降级的判据(classifyPickDegrade): 观测结果而不是观测代码路径", () => {
  it("15 天内用过 = 回头刊; 学科码不符且非综合刊 = 不对口; 两者任一都算降级", async () => {
    S.journalRow = { disciplineCode: "medicine", lastUsedAt: new Date(Date.now() - 3 * 86_400_000) };
    const stale = await classifyPickDegrade("t1", "j1", "medicine");
    expect(stale).toMatchObject({ staleReuse: true, offTopic: false, degraded: true });
    expect(describePickDegrade("domestic", "medicine", stale)).toContain("冷却");

    S.journalRow = { disciplineCode: "law", lastUsedAt: null };
    const off = await classifyPickDegrade("t1", "j1", "medicine");
    expect(off).toMatchObject({ staleReuse: false, offTopic: true, degraded: true });

    // 综合刊(generic)是层②④ 的正常兜底, 不算降级
    S.journalRow = { disciplineCode: "generic", lastUsedAt: null };
    expect((await classifyPickDegrade("t1", "j1", "medicine")).degraded).toBe(false);

    // 新鲜 + 对口 = 完全正常
    S.journalRow = { disciplineCode: "medicine", lastUsedAt: null };
    expect((await classifyPickDegrade("t1", "j1", "medicine")).degraded).toBe(false);
  });
});

describe("简报: 新 kind 都有人话标签与正确严重度", () => {
  const base = {
    health: { status: "ok" as const, timestamp: "", checks: {} },
    supplier: { aliyunAvailableYuan: null, aliyunCurrency: null, aliyunError: null, avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0, level: "ok" as const, reasons: [] as string[] },
  };
  const one = (kind: string, count: number, lastMessage: string) =>
    judgePlatform({ ...base, incidents: [{ kind, count, lastMessage, lastAt: new Date() }] }).items[0]!;

  it("每个新 kind 都进了 KIND_LABEL(否则简报只显示原始英文 kind)", () => {
    for (const k of ["low_output", "no_topic_available", "no_journal_available", "journal_pool_exhausted",
      "candidate_skipped", "generation_failed", "draft_shortfall", "draft_remedy_failed", "quality_gate_unavailable"]) {
      expect(KIND_LABEL[k], `KIND_LABEL 缺 ${k}`).toBeTruthy();
    }
  });

  it("产出不足 = 黄; 期刊池告急 = 黄 + 说清该补刊还是降配额", () => {
    expect(one("low_output", 1, "每日生成只出 1/20 篇").level).toBe("warn");
    const pool = one("journal_pool_exhausted", 6, "选刊降级[国内核心·medicine]: 破 15 天冷却重复用刊");
    expect(pool.level).toBe("warn");
    expect(pool.text).toContain("补该学科的刊");
  });

  // 8-02 去重: 平台级 draft_shortfall 不再渲染 —— 与租户级②「N 个公众号未达保底」是同一件事
  //   (7-29 起两边同用 countTodayAccountLoad 这把尺子), 实测同一天报了🔴+🟡两条、级别还打架。
  //   留租户那条(点名到号, 能直接去处理)。**严重度分级的保护没丢**, 搬到了 judgeTenant:
  //   见 ops-daily-briefing.test.ts「有号今日 0 篇 → alert」。
  it("8-02 分发缺口: 平台级不再重复渲染(租户级已报且点名到号)", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "draft_shortfall", count: 1, lastMessage: "2/3 个公众号未达每日保底(2篇), 其中 1 个号今日 0 篇", lastAt: new Date() }],
    });
    expect(items.some((i) => i.text.includes("未达每日保底"))).toBe(false);
  });

  it("8-02 期刊池 forecast 同样不再重复渲染(池简报那条已覆盖且更可读)", () => {
    const { items } = judgePlatform({
      ...base,
      incidents: [{ kind: "journal_pool_forecast", count: 1, lastMessage: "期刊池预判[国际刊·教育学]", lastAt: new Date() }],
    });
    expect(items).toHaveLength(0);
  });

  it("补救本身失败 = 红(这是我们自己的代码坏了, 不是没料)", () => {
    expect(one("draft_remedy_failed", 1, "补救失败").level).toBe("alert");
  });

  it("质检闸不可用: 措辞必须写死『不是内容违规』, 防运营去删稿", () => {
    const it5 = one("quality_gate_unavailable", 6, "红线规则查不了");
    expect(it5.level).toBe("alert");
    expect(it5.text).toContain("不是内容违规");
  });
});
