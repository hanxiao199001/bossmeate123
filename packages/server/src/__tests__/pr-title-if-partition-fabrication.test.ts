import { describe, it, expect } from "vitest";
import { checkTitleDataConsistency, fabricationPublishGate } from "../services/compliance/content-check.js";

/**
 * 7-20 标题编造校验补 IF / 分区两维（信任红线）。
 *
 * 背景: 原校验只查 审稿周期(天/周/月) + 录用率(%), 注释写"IF/分区几乎必复现, 不查以免误伤"
 *   —— 该前提只对国际刊成立。国内核心刊 2746 本里 有IF 213 本(7.8%)、有分区 8 本(0.3%),
 *   DB 没有 → LLM 只能编, 而校验对它睁眼瞎。生产实测近30天: 国内刊 185 篇里 57 篇(31%)
 *   标题写了 DB 没有的 IF, 40 篇 status=generated 可发布、6 篇已推送草稿/已发出。
 *
 * 设计要点(与审稿/录用率的差异):
 *   IF/分区 **只做 DB 有无校验, 不做正文复现** —— 一致编造(标题正文都写 IF 2.0)对国内刊是常态,
 *   正文本身就是 LLM 写的, 复现校验拦不住; DB 空 = 该刊客观没这个指标 = 标题数字必然无源。
 */

// 国内核心刊典型: 有身份(北大核心/CSCD)但 IF/分区/审稿/录用率全空
const DOMESTIC_EMPTY = {
  reviewCycle: null, acceptanceRate: null,
  impactFactor: null, compositeImpactFactor: null,
  partition: null, casPartition: null, casPartitionNew: null, jcrFull: null,
};
// 国际刊典型: IF/分区俱全。
// ⚠️ 分区数据实际落在 cas_partition_new(国际刊 2182 本)与 jcr_full(4158 本);
//    partition 仅 32 本、cas_partition **整列为空(0 行)** —— 早期只查前两者时,
//    近30天 734 篇国际刊里有 164 篇被误判"编造分区"。故 fixture 用真实字段。
const INTL_FULL = {
  reviewCycle: "约2个月", acceptanceRate: 35,
  impactFactor: 6.1, compositeImpactFactor: null,
  partition: null, casPartition: null, casPartitionNew: "1区", jcrFull: { wosLevel: "Q1" },
};

describe("IF 维度", () => {
  it("国内刊: DB 无 IF, 标题写 'IF 2.0+' → 判编造", () => {
    const r = checkTitleDataConsistency(
      "中国慢性病预防与控制，IF 2.0+，双核心，闭眼冲！",
      "<p>这本北大核心+CSCD期刊，认可度高。</p>",
      DOMESTIC_EMPTY,
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无影响因子数据"))).toBe(true);
  });

  it("国内刊: 一致编造(标题与正文都写 IF 2.0)仍然拦得住 — 这是不做正文复现的理由", () => {
    const r = checkTitleDataConsistency(
      "土木工程与管理学报 IF 3.2+，沾边就收！",
      "<p>该刊影响因子 3.2，学术声誉稳定。</p>", // 正文复现了, 但 DB 本来就没有
      DOMESTIC_EMPTY,
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无影响因子数据"))).toBe(true);
  });

  it("'影响因子 3.5' 中文写法同样命中", () => {
    const r = checkTitleDataConsistency("某国内核心，影响因子 3.5，值得投", "<p>正文</p>", DOMESTIC_EMPTY);
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无影响因子数据"))).toBe(true);
  });

  it("国际刊: DB 有 IF, 标题写 IF → 放行(有据不拦)", () => {
    const r = checkTitleDataConsistency(
      "6.1分Cell子刊，IF 6.1，值得冲",
      "<p>审稿周期约2个月。</p>",
      INTL_FULL,
    );
    expect(r.ok).toBe(true);
  });

  it("国内刊: DB 有复合IF(万方回填)时, 标题写 IF → 放行", () => {
    const r = checkTitleDataConsistency(
      "某医学核心，IF 1.2，审稿友好",
      "<p>正文</p>",
      { ...DOMESTIC_EMPTY, compositeImpactFactor: 1.24 },
    );
    expect(r.ok).toBe(true);
  });

  it("标题不提 IF → 不因缺 IF 而误伤(国内刊正常标题应放行)", () => {
    const r = checkTitleDataConsistency(
      "北大核心+CSCD双收录，预防医学方向对口，毕业评职可用",
      "<p>该刊被北大核心与 CSCD 收录。</p>",
      DOMESTIC_EMPTY,
    );
    expect(r.ok).toBe(true);
    expect(r.mismatches).toHaveLength(0);
  });
});

describe("分区维度", () => {
  it("国内刊: DB 无分区, 标题写 '中科院1区' → 判编造", () => {
    const r = checkTitleDataConsistency("某国内核心，中科院1区，闭眼冲", "<p>正文</p>", DOMESTIC_EMPTY);
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无分区数据"))).toBe(true);
  });

  it("'JCR Q2' 写法命中", () => {
    const r = checkTitleDataConsistency("某刊 JCR Q2 好投", "<p>正文</p>", DOMESTIC_EMPTY);
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无分区数据"))).toBe(true);
  });

  it("中文数字 '一区' 命中", () => {
    const r = checkTitleDataConsistency("某刊一区水刊，好中", "<p>正文</p>", DOMESTIC_EMPTY);
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无分区数据"))).toBe(true);
  });

  it("国际刊: DB 有分区 → 放行", () => {
    const r = checkTitleDataConsistency("Cell子刊 中科院1区，IF 6.1", "<p>审稿周期约2个月。</p>", INTL_FULL);
    expect(r.ok).toBe(true);
  });

  it("只有 casPartition 也算有据", () => {
    const r = checkTitleDataConsistency("某刊 2区，值得投", "<p>正文</p>", { ...DOMESTIC_EMPTY, casPartition: "2区" });
    expect(r.ok).toBe(true);
  });

  it("回归: casPartitionNew 是分区的真实落库字段, 必须算有据(否则误伤 164 篇国际刊)", () => {
    const r = checkTitleDataConsistency("某刊 中科院3区，审稿快", "<p>正文</p>", { ...DOMESTIC_EMPTY, casPartitionNew: "3区" });
    expect(r.mismatches.some((m) => m.includes("分区"))).toBe(false);
  });

  it("回归: jcrFull 有值也算分区有据(JCR Qx 声明的依据)", () => {
    const r = checkTitleDataConsistency("某刊 JCR Q1 顶刊", "<p>正文</p>", { ...DOMESTIC_EMPTY, jcrFull: { wosLevel: "Q1" } });
    expect(r.mismatches.some((m) => m.includes("分区"))).toBe(false);
  });
});

describe("与既有维度/行为的兼容", () => {
  it("审稿/录用率原有行为不变(DB 空 → 拦)", () => {
    const r = checkTitleDataConsistency(
      "某国内核心，审稿60天，录用率70%",
      "<p>正文未复现。</p>",
      DOMESTIC_EMPTY,
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无审稿周期数据"))).toBe(true);
    expect(r.mismatches.some((m) => m.includes("DB无录用率数据"))).toBe(true);
  });

  it("不传 dbFields → IF/分区维度跳过(退化为原行为, 不误伤)", () => {
    const r = checkTitleDataConsistency("某刊 IF 2.0+，中科院1区", "<p>正文</p>");
    expect(r.ok).toBe(true); // 无 DB 依据时不臆断
  });

  it("护栏: 调用方只传 {reviewCycle,acceptanceRate}(IF字段整个缺席) → IF/分区维度跳过, 不误伤", () => {
    // 这些字段类型上都可选, 漏传 TS 拦不住。若按"值为 null"判定, 会把所有带 IF 的标题全判编造
    // (实测会误伤近30天 708/734 篇国际刊)。故实现用 `"impactFactor" in db` 显式存在性判断。
    const r = checkTitleDataConsistency(
      "IF9.0+中科院1区管理学，1个月光速录用",
      "<p>正文</p>",
      { reviewCycle: "1个月", acceptanceRate: null },
    );
    expect(r.mismatches.some((m) => m.includes("影响因子"))).toBe(false);
    expect(r.mismatches.some((m) => m.includes("分区"))).toBe(false);
  });

  it("护栏反面: 显式传了 impactFactor:null → 确实查, 判编造", () => {
    const r = checkTitleDataConsistency(
      "某国内核心 IF 2.0+",
      "<p>正文</p>",
      { reviewCycle: null, acceptanceRate: null, impactFactor: null, compositeImpactFactor: null },
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无影响因子数据"))).toBe(true);
  });

  it("生产真实案例: 那篇 IF+审稿双编造的标题, 两维一起报出来", () => {
    const r = checkTitleDataConsistency(
      "预防医学毕业党必看！中国慢性病预防与控制，IF 2.0+，审稿60天，沾边就收，闭眼冲！",
      "<p>录用率暂无数据，审稿周期暂无数据。</p>",
      DOMESTIC_EMPTY,
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.some((m) => m.includes("DB无审稿周期数据"))).toBe(true);
    expect(r.mismatches.some((m) => m.includes("DB无影响因子数据"))).toBe(true);
  });
});

describe("发布期硬闸(fabricationPublishGate)复用同一校验", () => {
  it("已标 needs_review 的国内刊内容, 标题带无据 IF → block", () => {
    const g = fabricationPublishGate({
      status: "needs_review",
      title: "某国内核心，IF 2.0+，闭眼冲",
      body: "<p>正文</p>",
      dbFields: DOMESTIC_EMPTY,
    });
    expect(g.action).toBe("block");
    expect(g.mismatches.some((m) => m.includes("DB无影响因子数据"))).toBe(true);
  });

  it("未 flagged 的正常内容零触发(保证零回归)", () => {
    const g = fabricationPublishGate({
      status: "generated",
      title: "某国内核心，IF 2.0+，闭眼冲",
      body: "<p>正文</p>",
      dbFields: DOMESTIC_EMPTY,
    });
    expect(g.action).toBe("pass");
  });

  it("forceOverride → override(强发落审计, 不静默放行)", () => {
    const g = fabricationPublishGate({
      status: "needs_review",
      title: "某国内核心，中科院1区",
      body: "<p>正文</p>",
      dbFields: DOMESTIC_EMPTY,
      forceOverride: true,
    });
    expect(g.action).toBe("override");
    expect(g.mismatches.length).toBeGreaterThan(0);
  });
});
