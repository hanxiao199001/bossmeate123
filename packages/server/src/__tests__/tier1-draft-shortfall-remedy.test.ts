/**
 * 7-28 ①c —— 草稿分发缺口: 从"一行 logger.warn"升级成"落库 + 真去补一轮"。
 *
 * 原状: 两轮保底后仍有号没到下限, 只有 `logger.warn`。老板不看日志 =>
 *   系统其实早就算出了"某某号今天只有 0/2 篇", 但这个数字只送去给人看, 等于不存在。
 *
 * 本测试锁的四条护栏(补救最怕的是"救出更大的事故"):
 *   ① 只放宽**时效窗口**(7 天 → 21 天), 对口/质检/红线/一篇一号一律不放宽
 *   ② 只跑一轮, 且天然幂等(主轮推成功的内容已落 publish_log, 补救轮查不到它)
 *   ③ 有 env 开关, 关掉后只告警不补
 *   ④ 缺口按**实推结果**重算(不是配对时的预期) —— 配上了却推失败的号才最需要补
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// drizzle 的算子在本测试里只做占位, 真正的分派靠下面 db mock 记录的 table 身份
vi.mock("drizzle-orm", () => {
  const tag = () => ({ __sql: true });
  return { and: tag, or: tag, eq: tag, gte: tag, inArray: tag, desc: tag, sql: Object.assign(tag, { raw: tag }) };
});

const TBL = { contents: { __t: "contents" }, contentPublishLog: { __t: "publish_log" }, platformAccounts: { __t: "accounts" }, tenants: { __t: "tenants" } };
vi.mock("../models/schema.js", () => TBL);
vi.mock("../config/system-recommendation.js", () => ({ SYSTEM_RECOMMENDATION_TENANT_ID: "00000000-0000-0000-0000-000000000000" }));

const envMock = { DRAFT_PUSH_PER_ACCOUNT: 3, DRAFT_TARGET_PER_ACCOUNT: 2, DRAFT_SHORTFALL_REMEDY_ENABLED: true, DRAFT_SHORTFALL_REMEDY_WINDOW_DAYS: 21 };
vi.mock("../config/env.js", () => ({ env: envMock }));

// 出稿健康闸 / 编造闸: 本测试不关心, 一律放行(它们各有专门测试)
vi.mock("../services/publisher/output-health.js", () => ({
  checkOutputHealth: () => ({ healthy: true, codes: [], issues: [], summary: "" }),
  OUTPUT_UNHEALTHY_REASON: "output_unhealthy",
}));
// 7-28 (#6): draft-distributor 改调 checkPublishJournalGate(一次查库同时给判据①正文编造 +
//   判据⑤源刊可信度)。两个都 mock 成放行, 保持本测试只测缺口补救那条逻辑。
vi.mock("../services/compliance/content-check.js", () => ({
  checkBodyFabricationForPublish: async () => [],
  checkPublishJournalGate: async () => ({
    fabrication: [], aiFabricatedJournal: false, unverifiedJournal: false, journalCount: 0,
  }),
}));

const recordIncidentSpy = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../services/ops/incidents.js", () => ({ recordIncident: (...a: unknown[]) => recordIncidentSpy(...a) }));

const computeSmartPairsMock = vi.fn();
vi.mock("../services/publisher/smart-assign.js", () => ({ computeSmartPairs: (...a: unknown[]) => computeSmartPairsMock(...a) }));

const publishMock = vi.fn(async (_opts: { contentId: string; accountIds: string[] }) => [{ success: true, mediaId: "m1" }] as Array<Record<string, unknown>>);
vi.mock("../services/publisher/index.js", () => ({ publishToAccounts: (o: never) => publishMock(o) }));

// ---- db mock: 按"操作 + 目标表 + 是否 groupBy"路由到 state 里的假数据 ----
interface State {
  accounts: Array<{ id: string; accountName: string }>;
  /** 每次 buildFreshPool 取一份(第 1 次=主轮 7 天窗, 第 2 次=补救轮 21 天窗) */
  poolBatches: Array<Array<{ id: string; title: string; body: string; status: string; metadata: unknown }>>;
  /** 已推过的 contentId(主轮推成功后自动累加, 模拟 publish_log 幂等) */
  pushedIds: Set<string>;
  /** 今日各号载荷(pushPairs 成功即 +1) */
  load: Map<string, number>;
}
let S: State;
let poolCall = 0;

function builder(kind: "select" | "update" | "insert", table: { __t: string }) {
  let grouped = false;
  const self: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "set", "values", "onConflictDoUpdate"]) {
    self[m] = (arg: unknown) => {
      if (m === "from") return builderFrom(kind, arg as { __t: string }, () => grouped);
      return self;
    };
  }
  self.groupBy = () => { grouped = true; return self; };
  self.then = (res: (v: unknown) => void) => res(kind === "select" ? [] : undefined);
  void table;
  return self;
}
function builderFrom(kind: "select" | "update" | "insert", table: { __t: string }, isGrouped: () => boolean) {
  let grouped = false;
  const self: Record<string, unknown> = {};
  for (const m of ["where", "orderBy", "limit"]) self[m] = () => self;
  self.groupBy = () => { grouped = true; return self; };
  self.then = (res: (v: unknown) => void) => {
    void isGrouped;
    if (table.__t === "accounts") return res(S.accounts);
    if (table.__t === "contents") {
      const batch = S.poolBatches[Math.min(poolCall++, S.poolBatches.length - 1)] ?? [];
      return res(batch);
    }
    if (table.__t === "publish_log") {
      if (grouped) return res([...S.load.entries()].map(([accountId, n]) => ({ accountId, n: String(n) })));
      return res([...S.pushedIds].map((contentId) => ({ contentId })));
    }
    return res([]);
  };
  void kind;
  return self;
}

vi.mock("../models/db.js", () => ({
  db: {
    select: () => builder("select", TBL.contents),
    update: (t: { __t: string }) => builder("update", t),
    insert: (t: { __t: string }) => {
      const self: Record<string, unknown> = {};
      self.values = (v: { contentId?: string; accountId?: string }) => {
        if (t.__t === "publish_log" && v?.contentId) {
          S.pushedIds.add(v.contentId);
          if (v.accountId) S.load.set(v.accountId, (S.load.get(v.accountId) ?? 0) + 1);
        }
        return self;
      };
      self.onConflictDoUpdate = () => self;
      self.then = (res: (v: unknown) => void) => res(undefined);
      return self;
    },
  },
}));

const { distributeDraftsForTenant } = await import("../services/publisher/draft-distributor.js");

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** reportDistIncident 是 void async 旁路(内含动态 import) —— 断言前等它真正落完 */
async function flushIncidents(n: number): Promise<void> {
  await vi.waitFor(() => expect(recordIncidentSpy.mock.calls.length).toBeGreaterThanOrEqual(n), { timeout: 2000, interval: 5 });
}
/** 断言"没有告警"时: 让旁路的微任务跑完再看 */
async function settle(): Promise<void> { await new Promise((r) => setTimeout(r, 60)); }
const art = (id: string) => ({ id, title: `文章${id}`, body: "<p>正文</p>", status: "generated", metadata: {} });

beforeEach(() => {
  poolCall = 0;
  S = { accounts: [{ id: "acc-1", accountName: "教育号" }], poolBatches: [[]], pushedIds: new Set(), load: new Map() };
  recordIncidentSpy.mockReset();
  computeSmartPairsMock.mockReset();
  publishMock.mockClear();
  publishMock.mockResolvedValue([{ success: true, mediaId: "m1" }]);
  envMock.DRAFT_SHORTFALL_REMEDY_ENABLED = true;
  envMock.DRAFT_SHORTFALL_REMEDY_WINDOW_DAYS = 21;
});

/** computeSmartPairs 按传入的 articleIds 配前 n 篇给 accountIds[0] */
function pairFirst(n: number) {
  return async (opts: { articleIds: string[]; accountIds?: string[] }) => ({
    pairs: opts.articleIds.slice(0, n).map((articleId) => ({ articleId, accountId: opts.accountIds?.[0] ?? "acc-1", discipline: null })),
    unmatched: [],
    shortfalls: [],
  });
}

describe("① 缺口触发补救: 只放宽时效窗口", () => {
  it("主轮只推到 1/2 → 自动跑补救轮补到 2/2, 且不再告警", async () => {
    S.poolBatches = [[art("a1")], [art("a1"), art("a2")]]; // 7天窗只有1篇; 21天窗多出1篇老文
    computeSmartPairsMock.mockImplementation(pairFirst(1));

    const r = await distributeDraftsForTenant(TENANT);

    expect(r.pushed).toBe(2);                       // 主轮 1 + 补救 1
    expect(r.remedy?.attempted).toBe(true);
    expect(r.remedy?.windowDays).toBe(21);
    expect(r.remedy?.pushed).toBe(1);
    expect(r.remedy?.shortfallsBefore).toBe(1);
    expect(r.remedy?.shortfallsAfter).toBe(0);
    expect(r.shortfalls).toEqual([]);
    // 补平了就不该再打扰人
    await settle();
    expect(recordIncidentSpy).not.toHaveBeenCalled();
  });

  it("补救轮的候选来自**同一套闸门**, 只是窗口更长 —— 主轮已推的那篇不会被重复推(幂等)", async () => {
    S.poolBatches = [[art("a1")], [art("a1"), art("a2")]];
    computeSmartPairsMock.mockImplementation(pairFirst(1));
    await distributeDraftsForTenant(TENANT);

    // 第 2 次 computeSmartPairs 拿到的 articleIds 里不含 a1(它已落 publish_log 被排除)
    const secondCall = computeSmartPairsMock.mock.calls[1]![0] as { articleIds: string[]; accountIds: string[] };
    expect(secondCall.articleIds).toEqual(["a2"]);
    // 而且只补缺口号, 不顺手把达标号也塞满
    expect(secondCall.accountIds).toEqual(["acc-1"]);
    const pushedIds = publishMock.mock.calls.map((c) => c[0].contentId);
    expect(new Set(pushedIds).size).toBe(pushedIds.length); // 同一篇绝不推两次
  });
});

describe("② 补救救不回来 → 落 draft_shortfall incident(带每号缺口明细)", () => {
  it("补救轮也没内容 → 告警, 明细含号名/实得/目标", async () => {
    S.poolBatches = [[art("a1")], [art("a1")]]; // 21 天窗也没有新料
    computeSmartPairsMock.mockImplementation(pairFirst(1));

    const r = await distributeDraftsForTenant(TENANT);
    expect(r.remedy?.skippedReason).toBe("no_extra_content");
    expect(r.shortfalls).toEqual([{ accountId: "acc-1", accountName: "教育号", assigned: 1, target: 2 }]);

    await flushIncidents(1);
    expect(recordIncidentSpy).toHaveBeenCalledTimes(1);
    const inc = recordIncidentSpy.mock.calls[0]![0] as { kind: string; severity: string; message: string; detail: Record<string, unknown> };
    expect(inc.kind).toBe("draft_shortfall");
    expect(inc.severity).toBe("warn");          // 有货只是不够 → 黄
    expect(inc.message).toContain("未达每日保底");
    expect((inc.detail.shortfallsAfter as unknown[]).length).toBe(1);
  });

  it("有号今日 0 篇 → 升级 error(该号今天彻底没东西发)", async () => {
    S.poolBatches = [[], []];
    computeSmartPairsMock.mockImplementation(pairFirst(0));

    const r = await distributeDraftsForTenant(TENANT);
    expect(r.pushed).toBe(0);
    await flushIncidents(1);
    const inc = recordIncidentSpy.mock.calls[0]![0] as { kind: string; severity: string; message: string };
    expect(inc.kind).toBe("draft_shortfall");
    expect(inc.severity).toBe("error");
    expect(inc.message).toContain("今日 0 篇");
  });
});

describe("③ 开关 + 防循环", () => {
  it("DRAFT_SHORTFALL_REMEDY_ENABLED=false → 不补救, 但照样告警(绝不静默)", async () => {
    envMock.DRAFT_SHORTFALL_REMEDY_ENABLED = false;
    S.poolBatches = [[art("a1")], [art("a1"), art("a2")]];
    computeSmartPairsMock.mockImplementation(pairFirst(1));

    const r = await distributeDraftsForTenant(TENANT);
    expect(r.remedy?.attempted).toBe(false);
    expect(r.remedy?.skippedReason).toContain("disabled");
    expect(computeSmartPairsMock).toHaveBeenCalledTimes(1); // 没跑第二轮
    await flushIncidents(1);
    expect(recordIncidentSpy).toHaveBeenCalledTimes(1);
  });

  it("补救**只跑一轮** —— 补完还差也不会再补(防无限循环)", async () => {
    S.poolBatches = [[art("a1")], [art("a1"), art("a2")], [art("a1"), art("a2"), art("a3")]];
    computeSmartPairsMock.mockImplementation(pairFirst(0)); // 一篇都配不上, 缺口始终在
    await distributeDraftsForTenant(TENANT);
    expect(computeSmartPairsMock).toHaveBeenCalledTimes(2); // 主轮 1 + 补救 1, 到此为止
  });

  it("补救本身抛错 → 落 draft_remedy_failed, 主轮结果不受影响", async () => {
    S.poolBatches = [[art("a1")], [art("a1"), art("a2")]];
    computeSmartPairsMock
      .mockImplementationOnce(pairFirst(1))
      .mockImplementationOnce(async () => { throw new Error("配对服务炸了"); });

    const r = await distributeDraftsForTenant(TENANT);
    expect(r.pushed).toBe(1);                    // 主轮那篇仍在
    expect(r.remedy?.error).toContain("配对服务炸了");
    await flushIncidents(2);
    const kinds = recordIncidentSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("draft_remedy_failed");
    expect(kinds).toContain("draft_shortfall");
  });
});

describe("④ 缺口按实推结果重算, 不是按配对预期", () => {
  it("配上了但推失败 → 仍算缺口(这正是最需要补的情况)", async () => {
    S.poolBatches = [[art("a1"), art("a2")], [art("a1"), art("a2")]];
    computeSmartPairsMock.mockImplementation(pairFirst(2));
    publishMock.mockResolvedValue([{ success: false, error: "token 失效" }]);

    const r = await distributeDraftsForTenant(TENANT);
    expect(r.pushed).toBe(0);
    expect(r.failed).toBeGreaterThan(0);
    // computeSmartPairs 会认为"配满了没缺口", 但实推 0 篇 → 我们照样判缺口并告警
    expect(r.shortfalls?.[0]).toMatchObject({ accountId: "acc-1", assigned: 0, target: 2 });
    await flushIncidents(1);
    expect(recordIncidentSpy.mock.calls.some((c) => (c[0] as { kind: string }).kind === "draft_shortfall")).toBe(true);
  });
});
