import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { persistTrustedJournalFacts, INLINE_ENRICH_PROVENANCE } = await import(
  "../services/crawler/springer-journal-fetcher.js"
);

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
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); });

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
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); });

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
  beforeEach(() => { limitStub.mockReset(); setSpy.mockReset(); });

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
