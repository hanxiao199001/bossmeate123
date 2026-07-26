import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * 7-25 backlog-C 治本: enrichment 可信数据回写 journals 表。
 *
 * 病根(CLAUDE.md backlog-C): 生成时 ensureJournalEnriched 实时从 LetPub 抓 IF/分区喂 LLM,
 *   但**不回写 journals 表** → 事后三道编造闸都以 DB 为准 → "骑墙刊"(带 sci-core、DB 空、
 *   LetPub 有真数据)据实写的内容被判编造。
 *
 * 本测试锁死回写的三条铁律:
 *   ① 只收可信源(scrapling/LetPub), AI 猜的字段(casPartitionNew 等)永不入库
 *   ② 只填空、绝不覆盖(幂等: 第二次跑 0 写入)
 *   ③ 打来源标记 field_provenance = letpub_inline_enrich, 且不动 dataSource/confidence
 *
 * ⚠️ 7-25 事故后追加铁律 ④⑤(见文件末尾两个 describe 与 trusted-facts-guardrail.test.ts):
 *   ④ 写之前过 validateTrustedFacts, 不合理**整条拒写** + 落 ops_incidents
 *   ⑤ ENRICH_WRITEBACK_ENABLED **默认 false**, 关着时只校验不落笔
 *   所以本文件"能写入"的用例全部需要显式把开关打开(beforeEach 里做)。
 */

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    CREDENTIALS_KEY: "test-credentials-key",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const limitStub = vi.fn();
const setSpy = vi.fn();

vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: limitStub }) }) }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        setSpy(payload);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  },
}));

vi.mock("../models/schema.js", () => ({
  journals: {
    id: "id-col",
    impactFactor: "impact_factor",
    partition: "partition",
    casPartition: "cas_partition",
    acceptanceRate: "acceptance_rate",
    reviewCycle: "review_cycle",
    website: "website",
    fieldProvenance: "field_provenance",
  },
}));

vi.mock("drizzle-orm", () => ({ eq: () => "eq-stub" }));

/** 拒写时会动态 import 这个模块落 ops_incidents —— 拦下来做断言 */
const recordIncidentSpy = vi.fn();
vi.mock("../services/ops/incidents.js", () => ({
  recordIncident: (...args: unknown[]) => { recordIncidentSpy(...args); return Promise.resolve(); },
}));

const { persistTrustedJournalFacts, INLINE_ENRICH_PROVENANCE, isWriteBackEnabled, __resetWriteBackAlertThrottle } = await import(
  "../services/crawler/springer-journal-fetcher.js"
);

/** ⑤ 开关默认 false —— 本文件绝大多数用例测的是"开着时怎么写", 统一在这里打开 */
const enableWriteBack = () => { process.env.ENRICH_WRITEBACK_ENABLED = "true"; };
const ORIGINAL_SWITCH = process.env.ENRICH_WRITEBACK_ENABLED;
afterAll(() => {
  if (ORIGINAL_SWITCH === undefined) delete process.env.ENRICH_WRITEBACK_ENABLED;
  else process.env.ENRICH_WRITEBACK_ENABLED = ORIGINAL_SWITCH;
});

/** 骑墙刊现状: DB 里 IF/分区/录用率/审稿周期全空(地理科学进展就是这形态) */
const EMPTY_ROW = {
  impactFactor: null, partition: null, casPartition: null,
  acceptanceRate: null, reviewCycle: null, fieldProvenance: null,
};

/** LetPub 实时抓到的真数据 */
const LETPUB_TRUSTED = {
  impactFactor: 4.3,
  partition: "Q1",
  casPartition: "地球科学2区",
  acceptanceRate: 0.28,
  reviewCycle: "3个月",
};

describe("backlog-C 回写: 骑墙刊(DB 空) → 写入 + 打来源标记", () => {
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); recordIncidentSpy.mockReset(); __resetWriteBackAlertThrottle(); enableWriteBack(); });

  it("DB 四项全空 → 五个信任字段全部写入", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    const r = await persistTrustedJournalFacts("j-qiaoqiang", LETPUB_TRUSTED);

    expect(r.written.sort()).toEqual(
      ["acceptanceRate", "casPartition", "impactFactor", "partition", "reviewCycle"]
    );
    expect(r.skippedExisting).toEqual([]);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const payload = setSpy.mock.calls[0][0];
    expect(payload.impactFactor).toBe(4.3);
    expect(payload.casPartition).toBe("地球科学2区");
    expect(payload.reviewCycle).toBe("3个月");
  });

  it("每个写入字段都打 field_provenance = letpub_inline_enrich", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);

    const prov = setSpy.mock.calls[0][0].fieldProvenance as Record<string, string>;
    expect(INLINE_ENRICH_PROVENANCE).toBe("letpub_inline_enrich");
    for (const f of ["impactFactor", "partition", "casPartition", "acceptanceRate", "reviewCycle"]) {
      expect(prov[f]).toBe(INLINE_ENRICH_PROVENANCE);
    }
  });

  it("已有的 field_provenance 键被保留(merge, 不整体覆盖)", async () => {
    limitStub.mockResolvedValueOnce([{ ...EMPTY_ROW, fieldProvenance: { website: "openalex", jcrFull: "letpub" } }]);
    await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);

    const prov = setSpy.mock.calls[0][0].fieldProvenance as Record<string, string>;
    expect(prov.website).toBe("openalex");
    expect(prov.jcrFull).toBe("letpub");
    expect(prov.impactFactor).toBe(INLINE_ENRICH_PROVENANCE);
  });

  it("🚫 绝不写 dataSource / confidence / lastVerifiedAt —— 单源回写不得给多源核实值降级", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);

    const payload = setSpy.mock.calls[0][0];
    expect(payload).not.toHaveProperty("dataSource");
    expect(payload).not.toHaveProperty("confidence");
    expect(payload).not.toHaveProperty("lastVerifiedAt");
    expect(payload).toHaveProperty("updatedAt");
  });
});

describe("backlog-C 回写: 只填空、绝不覆盖(含幂等)", () => {
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); recordIncidentSpy.mockReset(); __resetWriteBackAlertThrottle(); enableWriteBack(); });

  it("DB 已有 IF(人工核实值) → 该字段跳过, 只补真正空的那几个", async () => {
    limitStub.mockResolvedValueOnce([{ ...EMPTY_ROW, impactFactor: 9.9, reviewCycle: "6个月" }]);
    const r = await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);

    expect(r.skippedExisting.sort()).toEqual(["impactFactor", "reviewCycle"]);
    expect(r.written.sort()).toEqual(["acceptanceRate", "casPartition", "partition"]);
    const payload = setSpy.mock.calls[0][0];
    expect(payload).not.toHaveProperty("impactFactor"); // 人工的 9.9 动不了
    expect(payload).not.toHaveProperty("reviewCycle");
  });

  it("幂等: 第二次跑(DB 已被第一次填满) → 0 写入, 不发 UPDATE", async () => {
    limitStub.mockResolvedValueOnce([{ ...EMPTY_ROW, ...LETPUB_TRUSTED }]);
    const r = await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);

    expect(r.written).toEqual([]);
    expect(r.skippedExisting).toHaveLength(5);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("录用率 0 算'有值'不算空 → 不被覆盖(0 也是数据)", async () => {
    limitStub.mockResolvedValueOnce([{ ...EMPTY_ROW, acceptanceRate: 0 }]);
    const r = await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);

    expect(r.skippedExisting).toContain("acceptanceRate");
    expect(r.written).not.toContain("acceptanceRate");
  });
});

describe("backlog-C 回写: 可信源边界(AI 猜的绝不入库)", () => {
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); recordIncidentSpy.mockReset(); __resetWriteBackAlertThrottle(); enableWriteBack(); });

  it("🚫 casPartitionNew 不在白名单 —— 它的唯一来源是 enrichJournalWithAI(模型猜的)", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    await persistTrustedJournalFacts("j-1", {
      ...LETPUB_TRUSTED,
      casPartitionNew: "医学1区TOP", // AI 编的, 必须被丢掉
    });

    const payload = setSpy.mock.calls[0][0];
    expect(payload).not.toHaveProperty("casPartitionNew");
  });

  it("🚫 非校验器读的字段(annualVolume/selfCitationRate/isWarningList/website)不回写 —— 回写面=校验面", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    await persistTrustedJournalFacts("j-1", {
      ...LETPUB_TRUSTED,
      annualVolume: 1200, selfCitationRate: 8, isWarningList: true, website: "https://x.example",
    });

    const payload = setSpy.mock.calls[0][0];
    for (const k of ["annualVolume", "selfCitationRate", "isWarningList", "website"]) {
      expect(payload).not.toHaveProperty(k);
    }
  });

  it("scrapling 什么都没抓到 → 不查库、不写库", async () => {
    const r = await persistTrustedJournalFacts("j-1", {});
    expect(r.written).toEqual([]);
    expect(limitStub).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("journalId = 'skip-cache' / 空 / trusted=null → 全部不写", async () => {
    expect((await persistTrustedJournalFacts("skip-cache", LETPUB_TRUSTED)).written).toEqual([]);
    expect((await persistTrustedJournalFacts("", LETPUB_TRUSTED)).written).toEqual([]);
    expect((await persistTrustedJournalFacts("j-1", null)).written).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("刊不存在 → 不写", async () => {
    limitStub.mockResolvedValueOnce([]);
    const r = await persistTrustedJournalFacts("j-missing", LETPUB_TRUSTED);
    expect(r.written).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("DB 抛错 → 不抛异常, 生成链路不被拖挂", async () => {
    limitStub.mockRejectedValueOnce(new Error("connection refused"));
    const r = await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);
    expect(r).toEqual({ written: [], skippedExisting: [] });
  });
});

/**
 * ④ 7-25 事故加固: 合理性护栏。
 *
 * 事故实况: 上游 LetPub 改版, 选择器错位 → impactFactor=2026(年份)、name="按研究方向查看:"
 *   (导航文案)。回写把这些假值永久钉进 DB, 三道防编造闸因"DB 与提示词一致地错"而全部失效。
 * 锁死: 这批值一个都进不去, 且**整条拒写**(不挑着写看起来合法的那几个), 并落 ops_incidents。
 */
describe("④ 护栏: 上游解析漂移 → 整条拒写 + 告警", () => {
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); recordIncidentSpy.mockReset(); __resetWriteBackAlertThrottle(); enableWriteBack(); });

  const INCIDENT = {
    impactFactor: 2026,              // 抓到了页面上的年份
    partition: "Q1",                 // 这一格恰好长得合法 —— 正是它诱使人做"部分写入"
    casPartition: "地球科学2区",
    acceptanceRate: 0.28,
    reviewCycle: "3个月",
    sourceName: "按研究方向查看:",    // 导航文案 = 整页选择器失效的铁证
  };

  it("IF=2026 + name=导航文案 → written=[] / skipped=rejected / 不发 UPDATE", async () => {
    const r = await persistTrustedJournalFacts("j-1", INCIDENT);
    expect(r.written).toEqual([]);
    expect(r.skipped).toBe("rejected");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("拒写发生在读库之前 —— 连 SELECT 都不发(脏批次不该产生任何 DB 交互)", async () => {
    await persistTrustedJournalFacts("j-1", INCIDENT);
    expect(limitStub).not.toHaveBeenCalled();
  });

  it("🚫 绝不部分写入: 同批里合法的 partition/casPartition 也一并拒掉", async () => {
    const r = await persistTrustedJournalFacts("j-1", INCIDENT);
    expect(r.written).not.toContain("partition");
    expect(r.written).not.toContain("casPartition");
    // 校验结果里明确点名坏字段, 好字段不背锅但也不放行
    const badFields = r.validation!.rejected.map((x) => x.field).sort();
    expect(badFields).toEqual(["impactFactor", "sourceName"]);
  });

  it("落 ops_incidents(kind=enrich_writeback_rejected, severity=error) 让次日简报报出来", async () => {
    await persistTrustedJournalFacts("j-1", INCIDENT);
    // 动态 import 是 microtask, 等一拍
    await new Promise((res) => setTimeout(res, 0));
    expect(recordIncidentSpy).toHaveBeenCalledTimes(1);
    const arg = recordIncidentSpy.mock.calls[0][0] as Record<string, any>;
    expect(arg.kind).toBe("enrich_writeback_rejected");
    expect(arg.severity).toBe("error");          // drift → 高一档
    expect(arg.message).toContain("解析漂移");
    expect(arg.detail.journalId).toBe("j-1");
    expect(arg.detail.drift).toBe(true);
  });

  it("单字段异常(非漂移指纹) → 仍整条拒写, 但告警降为 warn", async () => {
    const r = await persistTrustedJournalFacts("j-1", { ...LETPUB_TRUSTED, impactFactor: 999 });
    expect(r.skipped).toBe("rejected");
    await new Promise((res) => setTimeout(res, 0));
    expect((recordIncidentSpy.mock.calls[0][0] as Record<string, any>).severity).toBe("warn");
  });

  it("健康数据不受影响(护栏不能误伤正常回写)", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    const r = await persistTrustedJournalFacts("j-1", { ...LETPUB_TRUSTED, sourceName: "地理科学进展" });
    expect(r.written).toHaveLength(5);
    expect(r.skipped).toBeUndefined();
    expect(recordIncidentSpy).not.toHaveBeenCalled();
  });

  it("探针 sourceName 本身永不入库(它只用来判断解析是否失效)", async () => {
    limitStub.mockResolvedValueOnce([EMPTY_ROW]);
    await persistTrustedJournalFacts("j-1", { ...LETPUB_TRUSTED, sourceName: "地理科学进展" });
    expect(setSpy.mock.calls[0][0]).not.toHaveProperty("sourceName");
  });
});

/**
 * ⑤ 7-25 事故加固: 回写开关默认关闭。
 * "代码在但不启用" —— 上游 LetPub 选择器重写并验证之前, 谁都不该无意中把它打开。
 */
describe("⑤ 开关: ENRICH_WRITEBACK_ENABLED 默认 false", () => {
  beforeEach(() => {
    limitStub.mockReset(); setSpy.mockReset(); recordIncidentSpy.mockReset();
    __resetWriteBackAlertThrottle();
    delete process.env.ENRICH_WRITEBACK_ENABLED; // 回到线上默认态
  });

  it("env 未设置 → isWriteBackEnabled() 为 false", () => {
    expect(isWriteBackEnabled()).toBe(false);
    process.env.ENRICH_WRITEBACK_ENABLED = "1";     // 只认字符串 "true", 别的都算关
    expect(isWriteBackEnabled()).toBe(false);
    process.env.ENRICH_WRITEBACK_ENABLED = "false";
    expect(isWriteBackEnabled()).toBe(false);
    process.env.ENRICH_WRITEBACK_ENABLED = "true";
    expect(isWriteBackEnabled()).toBe(true);
  });

  it("关着时: 数据再健康也不落笔(不 SELECT 不 UPDATE), skipped=disabled", async () => {
    const r = await persistTrustedJournalFacts("j-1", LETPUB_TRUSTED);
    expect(r.written).toEqual([]);
    expect(r.skipped).toBe("disabled");
    expect(limitStub).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("关着时仍然跑校验并告警(影子模式) —— 上游修没修好靠日常运行自动探出来", async () => {
    const r = await persistTrustedJournalFacts("j-1", { impactFactor: 2026 });
    expect(r.skipped).toBe("rejected");   // 注意: 不是 "disabled" —— 校验在开关之前
    await new Promise((res) => setTimeout(res, 0));
    expect(recordIncidentSpy).toHaveBeenCalledTimes(1);
  });

  it("开关只管落笔, 不影响入参判空等早退路径", async () => {
    expect((await persistTrustedJournalFacts("skip-cache", LETPUB_TRUSTED)).skipped).toBeUndefined();
    expect((await persistTrustedJournalFacts("j-1", {})).skipped).toBeUndefined();
  });
});

/** 告警节流: 上游坏掉时每篇生成都会命中, 不限速会把 ops_incidents 刷屏、淹掉别的告警 */
describe("④b 拒写告警的进程内节流(10 分钟一条, 被压次数不丢)", () => {
  beforeEach(() => {
    limitStub.mockReset(); setSpy.mockReset(); recordIncidentSpy.mockReset();
    __resetWriteBackAlertThrottle(); enableWriteBack();
  });

  it("连续 5 次拒写 → 只落 1 条 incident, 且带上被压掉的次数", async () => {
    for (let i = 0; i < 5; i++) await persistTrustedJournalFacts(`j-${i}`, { impactFactor: 2026 });
    await new Promise((res) => setTimeout(res, 0));
    expect(recordIncidentSpy).toHaveBeenCalledTimes(1);
    expect((recordIncidentSpy.mock.calls[0][0] as Record<string, any>).detail.suppressedSinceLastAlert).toBe(0);

    // 冷却窗口重置后再来一次 → 第二条带上前面被压掉的 4 次
    __resetWriteBackAlertThrottle();
    await persistTrustedJournalFacts("j-x", { impactFactor: 2026 });
    await new Promise((res) => setTimeout(res, 0));
    expect(recordIncidentSpy).toHaveBeenCalledTimes(2);
  });

  it("节流只压告警, 不影响拒写本身(每一次都照样不写库)", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await persistTrustedJournalFacts(`j-${i}`, { impactFactor: 2026 });
      expect(r.skipped).toBe("rejected");
    }
    expect(setSpy).not.toHaveBeenCalled();
  });
});
