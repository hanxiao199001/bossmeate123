/**
 * 数据卡格子校验 + 兜底文案 —— 红线 #14 的防回归（8-06）。
 *
 * 用的全是**生产实测值**: 8-06 扫近 30 天 116 篇带 IF 槽的内容, 非法 8 篇(6.9%),
 * 下面 not_numeric 那组就是那 8 条的原样。
 */
import { describe, it, expect } from "vitest";

const {
  checkImpactFactorSlot, checkPartitionSlot, checkAcceptanceRateSlot,
  shouldHideCard, collectSlotRejects, isEmptyMarker, SLOT_EMPTY, CARD_EMPTY_RATIO_LIMIT,
} = await import("../services/publisher/adapters/field-slot-guard.js");

describe("IF 槽只收数字", () => {
  it("合法数字通过", () => {
    expect(checkImpactFactorSlot(3.2)).toMatchObject({ ok: true, value: "3.2" });
    expect(checkImpactFactorSlot("7.4")).toMatchObject({ ok: true, value: "7.4" });
  });

  it("🔴 生产实测的 8 条非法值全部拦下", () => {
    const real = [
      "CSSCI来源期刊",
      "2023年复合IF约1.2",
      "0.917（复合影响因子）",
      "同类1区约5-6",
      "复合影响因子 0.694（2023版）",
      "新刊或暂无公开IF",
      "暂无IF数据",
      "暂无数据（该刊为中文核心，暂无JCR影响因子）",
    ];
    for (const v of real) {
      const r = checkImpactFactorSlot(v);
      expect(r.ok, `应拦下: ${v}`).toBe(false);
      expect(r.value).toBe(SLOT_EMPTY);
    }
  });

  it("🔴 刻意不从句子里抠数字 —— 抠出 1.2 等于把编造洗成事实", () => {
    // 「2023年复合IF约1.2」里确实有 1.2, 但那句话本身是无据的
    expect(checkImpactFactorSlot("2023年复合IF约1.2").ok).toBe(false);
    expect(checkImpactFactorSlot("0.917（复合影响因子）").ok).toBe(false);
  });

  it("年份型越界拦下(7-25 LetPub 改版把年份当 IF 抓回来过)", () => {
    expect(checkImpactFactorSlot(2026).ok).toBe(false);
    expect(checkImpactFactorSlot(2026).reject).toContain("out_of_range");
  });

  it("空/占位符判 empty(不算串位, 不进 warning 统计)", () => {
    for (const v of [null, undefined, "", "—", "暂无数据", "未知"]) {
      expect(checkImpactFactorSlot(v).ok).toBe(false);
      expect(checkImpactFactorSlot(v).reject).toBe("empty");
    }
  });
});

describe("分区槽只收合法分区格式", () => {
  it("合法格式通过", () => {
    for (const v of ["Q1", "Q4", "2区", "医学1区", "工程技术2区", "医学1区TOP"]) {
      expect(checkPartitionSlot(v).ok, `应通过: ${v}`).toBe(true);
    }
  });

  it("🔴 目录成员资格不是分区 —— 结构性错位必须拦", () => {
    for (const v of ["北大核心", "CSSCI来源期刊", "CSCD核心库", "中文核心"]) {
      const r = checkPartitionSlot(v);
      expect(r.ok, `应拦下: ${v}`).toBe(false);
      expect(r.reject).toContain("not_partition");
    }
  });
});

describe("录用率槽", () => {
  it("比值与百分数都规范化成百分数", () => {
    expect(checkAcceptanceRateSlot(0.18)).toMatchObject({ ok: true, value: "18%" });
    expect(checkAcceptanceRateSlot("25%")).toMatchObject({ ok: true, value: "25%" });
  });
  it("越界与非数拦下", () => {
    expect(checkAcceptanceRateSlot(1.5 * 100 + 1).ok).toBe(false);
    expect(checkAcceptanceRateSlot("较高").ok).toBe(false);
  });
});

describe("🔴 满卡暂无 = 空洞: 超过半数无数据整张卡不出现", () => {
  const S = (ok: boolean) => ({ ok });

  it("4 格里 3 格空 → 隐藏", () => {
    expect(shouldHideCard([S(true), S(false), S(false), S(false)])).toBe(true);
  });

  it("4 格里 2 格空(恰好半数) → 仍渲染(一格暂无是诚实)", () => {
    expect(shouldHideCard([S(true), S(true), S(false), S(false)])).toBe(false);
  });

  it("全空 → 隐藏", () => {
    expect(shouldHideCard([S(false), S(false), S(false), S(false)])).toBe(true);
  });

  it("全满 → 渲染", () => {
    expect(shouldHideCard([S(true), S(true), S(true), S(true)])).toBe(false);
  });

  it("空数组 → 隐藏(没格子就别画卡)", () => {
    expect(shouldHideCard([])).toBe(true);
  });

  it("阈值就是 0.5, 变了要有人知道", () => {
    expect(CARD_EMPTY_RATIO_LIMIT).toBe(0.5);
  });
});

describe("串位统计", () => {
  it("只收集真串位, empty 不算(否则统计里全是正常的没数据)", () => {
    const r = collectSlotRejects({
      a: checkImpactFactorSlot("CSSCI来源期刊"),
      b: checkImpactFactorSlot(null),
      c: checkImpactFactorSlot(3.2),
    });
    expect(Object.keys(r)).toEqual(["a"]);
    expect(r.a).toContain("not_numeric");
  });
});

describe("isEmptyMarker", () => {
  it("认得各种'明确标注无数据'的写法", () => {
    for (const v of ["", "—", "-", "暂无", "暂无数据", "未知", "待评估", "N/A"]) {
      expect(isEmptyMarker(v), v).toBe(true);
    }
    expect(isEmptyMarker("3.2")).toBe(false);
    expect(isEmptyMarker("Q1")).toBe(false);
  });
});

// ============ 出稿健康闸: 兜底文案词表 ============

const { checkOutputHealth } = await import("../services/publisher/output-health.js");

describe("🔴 兜底文案词表(红线 #14 第二道: 模板修完 LLM 还会自己写)", () => {
  const BODY_OK = "本刊聚焦教育学研究，收录于北大核心与 CSSCI。".repeat(20);

  it("无指标数据时, 「高影响力」被拦", () => {
    const r = checkOutputHealth({
      title: "期刊推荐", body: `${BODY_OK}这是一本高影响力的期刊。`, noMetricFacts: true,
    });
    expect(r.issues.some((i) => i.code === "fallback_phrase")).toBe(true);
  });

  it("无指标数据时, 「权威期刊」被拦", () => {
    const r = checkOutputHealth({
      title: "期刊推荐", body: `${BODY_OK}这本权威期刊值得投。`, noMetricFacts: true,
    });
    expect(r.issues.some((i) => i.code === "fallback_phrase")).toBe(true);
  });

  it("🔴 有指标数据时不拦 —— 有 IF 的刊说「高影响力」是正常行文, 不是编造", () => {
    const r = checkOutputHealth({
      title: "期刊推荐", body: `${BODY_OK}这是一本高影响力的期刊。`, noMetricFacts: false,
    });
    expect(r.issues.some((i) => i.code === "fallback_phrase")).toBe(false);
  });

  it("🔴 拿不到期刊事实(不传 noMetricFacts)时不判 —— 宁可漏报也不误杀", () => {
    const r = checkOutputHealth({ title: "期刊推荐", body: `${BODY_OK}这是一本高影响力的期刊。` });
    expect(r.issues.some((i) => i.code === "fallback_phrase")).toBe(false);
  });

  it("干净正文不误报", () => {
    const r = checkOutputHealth({ title: "期刊推荐", body: BODY_OK, noMetricFacts: true });
    expect(r.issues.some((i) => i.code === "fallback_phrase")).toBe(false);
  });
});
