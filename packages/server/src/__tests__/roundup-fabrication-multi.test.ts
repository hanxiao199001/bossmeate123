import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 7-25 多刊盘点(roundup)编造闸。
 *
 * 缺口: roundup 不走 batch-worker / quality-pipeline, 三道编造闸对它全部空转
 *   (findBodyFabrication 无 facts 直接 return []、checkTitleDataConsistency 无 dbFields、
 *    发布期硬闸查不到 journalId)。而它每天在产, 一篇说 3 本刊 = 编 IF/分区风险最高的形态。
 *
 * 方案取舍: 多刊没有单一 journalId → 用"并集刊"判定(任一刊有真 IF/分区就放行),
 *   而不是按刊名就近匹配 —— 后者在 LLM 改写 + HTML 重排后不可靠, 误判正是 6577b9a 被回滚的原因。
 *   再叠一层骑墙豁免(任一刊含 sci-core 就整篇跳过), 与 7-21 发布硬闸同口径。
 */

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    CREDENTIALS_KEY: "test-credentials-key",
    LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000,
    API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const whereStub = vi.fn();
vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: whereStub, limit: vi.fn() }) }),
  },
}));
vi.mock("../models/schema.js", () => ({
  journals: {
    id: "id", catalogs: "catalogs", reviewCycle: "review_cycle", acceptanceRate: "acceptance_rate",
    impactFactor: "impact_factor", compositeImpactFactor: "composite_impact_factor",
    partition: "partition", casPartition: "cas_partition", casPartitionNew: "cas_partition_new",
    jcrFull: "jcr_full",
  },
  tenants: { id: "id", config: "config" },
}));
vi.mock("drizzle-orm", () => ({ eq: () => "eq-stub", inArray: () => "inarray-stub" }));

const { mergeJournalFacts, findBodyFabricationMulti, checkRoundupFabrication, checkBodyFabricationForPublish } =
  await import("../services/compliance/content-check.js");

const NO_DATA = {
  reviewCycle: null, acceptanceRate: null, impactFactor: null, compositeImpactFactor: null,
  partition: null, casPartition: null, casPartitionNew: null, jcrFull: null,
};
const PURE_DOMESTIC = ["pku-core", "cssci"];
const QIAOQIANG = ["pku-core", "cscd", "sci-core"]; // 骑墙刊

describe("mergeJournalFacts: 多刊并集", () => {
  it("三本刊全空 → 并集仍全空(该查, 且判编造)", () => {
    const m = mergeJournalFacts([NO_DATA, NO_DATA, NO_DATA])!;
    expect(m.impactFactor).toBeNull();
    expect(m.casPartitionNew).toBeNull();
    expect("impactFactor" in m).toBe(true); // 键在 = 可以查
  });

  it("任一刊有真 IF → 并集算'有 IF'(正文写 IF 数字视为有源)", () => {
    const m = mergeJournalFacts([NO_DATA, { ...NO_DATA, impactFactor: 3.2 }, NO_DATA])!;
    expect(m.impactFactor).toBe(3.2);
  });

  it("任一刊有分区(casPartitionNew) → 并集算'有分区'", () => {
    const m = mergeJournalFacts([NO_DATA, { ...NO_DATA, casPartitionNew: "医学2区TOP" }])!;
    expect(m.casPartitionNew).toBe("医学2区TOP");
  });

  it("没人提供的键 → 保持缺席(键不存在 = 校验跳过, 不臆断)", () => {
    const m = mergeJournalFacts([{ reviewCycle: null }, { reviewCycle: "3个月" }])!;
    expect("impactFactor" in m).toBe(false);
    expect(m.reviewCycle).toBe("3个月");
  });

  it("空数组 → undefined(退化为不校验)", () => {
    expect(mergeJournalFacts([])).toBeUndefined();
    expect(mergeJournalFacts([null, undefined])).toBeUndefined();
  });
});

describe("findBodyFabricationMulti: 命中 / 不命中", () => {
  it("命中: 三本刊都没 IF/分区, 正文却写'IF 3.5'和'1区'", () => {
    const hits = findBodyFabricationMulti(
      "<p>《管理世界》影响因子 3.5，稳居管理学1区，评职称利器。</p>",
      [NO_DATA, NO_DATA, NO_DATA],
    );
    expect(hits.some((h) => h.includes("DB无影响因子"))).toBe(true);
    expect(hits.some((h) => h.includes("DB无分区"))).toBe(true);
  });

  it("不命中: 其中一本刊真有 IF 和分区 → 正文的数字视为有源, 放行", () => {
    const hits = findBodyFabricationMulti(
      "<p>《管理世界》影响因子 3.5，稳居管理学1区。</p>",
      [NO_DATA, { ...NO_DATA, impactFactor: 3.5, casPartitionNew: "管理学1区" }, NO_DATA],
    );
    expect(hits).toEqual([]);
  });

  it("不命中: 正文只讲核心身份/审稿方向, 不出现 IF/分区数字(合格盘点文)", () => {
    const hits = findBodyFabricationMulti(
      "<p>这三本都是北大核心+CSSCI，审稿以官网为准，方向对口最关键。</p>",
      [NO_DATA, NO_DATA, NO_DATA],
    );
    expect(hits).toEqual([]);
  });

  it("无期刊事实(journalIds 空) → 不判(退化为原行为, 零回归)", () => {
    expect(findBodyFabricationMulti("<p>IF 9.9，1区。</p>", [])).toEqual([]);
  });
});

describe("checkRoundupFabrication: 接库判定 + 骑墙豁免", () => {
  beforeEach(() => { whereStub.mockReset(); });

  it("三本纯国内刊全无数据 + 标题写'IF 4.0+' + 正文写'2区' → 命中转 needs_review", async () => {
    whereStub.mockResolvedValueOnce([
      { catalogs: PURE_DOMESTIC, ...NO_DATA },
      { catalogs: ["cscd"], ...NO_DATA },
      { catalogs: ["cssci-ext"], ...NO_DATA },
    ]);
    const r = await checkRoundupFabrication({
      title: "IF 4.0+ 的三本国内核心，普通教师也能中",
      body: "<p>其中两本已进中科院2区，含金量高。</p>",
      journalIds: ["a", "b", "c"],
    });
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("影响因子"))).toBe(true);
    expect(r.mismatches.some((m) => m.includes("分区"))).toBe(true);
  });

  it("🚫 任一刊是骑墙刊(含 sci-core) → 整篇豁免。roundup 不跑 enrichment, DB 空≠没数据, 查了就是 6577b9a 覆辙", async () => {
    whereStub.mockResolvedValueOnce([
      { catalogs: PURE_DOMESTIC, ...NO_DATA },
      { catalogs: QIAOQIANG, ...NO_DATA },
    ]);
    const r = await checkRoundupFabrication({
      title: "中科院1区盘点", body: "<p>IF 4.3，1区。</p>", journalIds: ["a", "b"],
    });
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("含国际刊(无中文核心标签) → 豁免(它们本就该有 IF/分区)", async () => {
    whereStub.mockResolvedValueOnce([
      { catalogs: PURE_DOMESTIC, ...NO_DATA },
      { catalogs: [], ...NO_DATA },
    ]);
    const r = await checkRoundupFabrication({ title: "t", body: "<p>IF 8.0</p>", journalIds: ["a", "b"] });
    expect(r.ok).toBe(true);
  });

  it("纯国内刊但其中一本真有复合影响因子 → 并集有源, 放行", async () => {
    whereStub.mockResolvedValueOnce([
      { catalogs: PURE_DOMESTIC, ...NO_DATA },
      { catalogs: PURE_DOMESTIC, ...NO_DATA, compositeImpactFactor: 5.1 },
    ]);
    const r = await checkRoundupFabrication({
      title: "复合影响因子 5.1 的两本核心", body: "<p>复合影响因子 5.1，认可度高。</p>", journalIds: ["a", "b"],
    });
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(true);
  });

  it("journalIds 为空 / 查不到刊 → 不判(不阻塞每日生成)", async () => {
    const r1 = await checkRoundupFabrication({ title: "t", body: "<p>IF 9</p>", journalIds: [] });
    expect(r1).toEqual({ ok: true, mismatches: [], checked: false });
    whereStub.mockResolvedValueOnce([]);
    const r2 = await checkRoundupFabrication({ title: "t", body: "<p>IF 9</p>", journalIds: ["x"] });
    expect(r2.ok).toBe(true);
  });

  it("DB 抛错 → 放行 + 不抛(每日生成绝不能被校验拖挂)", async () => {
    whereStub.mockRejectedValueOnce(new Error("db down"));
    const r = await checkRoundupFabrication({ title: "t", body: "<p>IF 9</p>", journalIds: ["x"] });
    expect(r).toEqual({ ok: true, mismatches: [], checked: false });
  });
});

describe("checkBodyFabricationForPublish: 接 journalIds(发布期多刊闸)", () => {
  beforeEach(() => { whereStub.mockReset(); });

  it("roundup 内容(metadata.journalIds) 全纯国内无数据 + 正文编分区 → 拦下", async () => {
    whereStub.mockResolvedValueOnce([
      { catalogs: PURE_DOMESTIC, ...NO_DATA },
      { catalogs: ["cscd"], ...NO_DATA },
    ]);
    const hits = await checkBodyFabricationForPublish({
      body: "<p>这两本都是中科院2区。</p>", journalIds: ["a", "b"],
    });
    expect(hits.some((h) => h.includes("DB无分区"))).toBe(true);
  });

  it("单刊调用行为与 7-21 完全一致(纯国内 + DB 空 → 拦)", async () => {
    whereStub.mockResolvedValueOnce([{ catalogs: PURE_DOMESTIC, ...NO_DATA }]);
    const hits = await checkBodyFabricationForPublish({ body: "<p>影响因子3.456。</p>", journalId: "a" });
    expect(hits.some((h) => h.includes("DB无影响因子"))).toBe(true);
  });

  it("单刊骑墙(含 sci-core) → 仍然豁免(不回归)", async () => {
    whereStub.mockResolvedValueOnce([{ catalogs: QIAOQIANG, ...NO_DATA }]);
    const hits = await checkBodyFabricationForPublish({ body: "<p>IF 4.3，1区。</p>", journalId: "a" });
    expect(hits).toEqual([]);
  });

  it("既无 journalId 也无 journalIds → 不查库, 放行", async () => {
    const hits = await checkBodyFabricationForPublish({ body: "<p>IF 9.9</p>" });
    expect(hits).toEqual([]);
    expect(whereStub).not.toHaveBeenCalled();
  });
});
