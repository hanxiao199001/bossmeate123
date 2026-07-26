import { describe, it, expect } from "vitest";
import {
  validateTrustedFacts,
  looksLikeNavText,
  isYearLike,
  parseReviewCycleDays,
  IF_MAX,
} from "../services/crawler/trusted-facts-validator.js";

/**
 * 7-25 事故用例集: enrichment 回写前的合理性护栏。
 *
 * 事故实况(用真实脏值做用例, 不编):
 *   - impactFactor = 2026        → 抓到了页面上的年份
 *   - name         = "按研究方向查看:" → 抓到了侧边导航文案
 *   - 两者同时出现               → 这是"解析漂移"而不是"单条脏数据"
 * 后果: 回写把假值永久钉进 journals 表, 三道防编造闸(正文/标题/六维评分)因 DB 与提示词
 *   "一致地错"而全部失效, 产出《2026 逆天影响因子》。
 *
 * 本文件锁死: 上述值一个都进不去, 且是**整条拒写**而不是挑着写。
 */

/** 事故当天 LetPub 实际返回的那一批(选择器错位后的产物) */
const INCIDENT_FACTS = {
  impactFactor: 2026,
  partition: "按研究方向查看:",
  casPartition: "更多>>",
  acceptanceRate: 2026,
  reviewCycle: "2026",
  sourceName: "按研究方向查看:",
};

/** 正常年份的正常抓取结果(回归基线, 必须全部放行) */
const HEALTHY_FACTS = {
  impactFactor: 4.3,
  partition: "Q1",
  casPartition: "地球科学2区",
  acceptanceRate: 0.28,
  reviewCycle: "3个月",
  sourceName: "地理科学进展",
};

describe("事故复盘: 那一批脏值必须整条被拒", () => {
  it("事故原样输入 → ok=false + drift=true(多字段同时异常=解析漂移)", () => {
    const r = validateTrustedFacts(INCIDENT_FACTS);
    expect(r.ok).toBe(false);
    expect(r.drift).toBe(true);
    // 六个字段全都被点名, 一个都不放
    expect(r.rejected.map((x) => x.field).sort()).toEqual(
      ["acceptanceRate", "casPartition", "impactFactor", "partition", "reviewCycle", "sourceName"],
    );
    expect(r.reason).toContain("疑似上游解析漂移");
  });

  it("IF=2026 被判定为 year_like(报错说人话: 疑似抓到年份), 不是笼统的越界", () => {
    const r = validateTrustedFacts({ impactFactor: 2026 });
    expect(r.ok).toBe(false);
    expect(r.rejected[0].rule).toBe("year_like");
    expect(r.rejected[0].detail).toContain("年份");
    // 单字段命中 year_like 也算 drift —— 它是结构性错位的指纹, 不是脏数据噪音
    expect(r.drift).toBe(true);
  });

  it('name="按研究方向查看:" 单独出现就足以否决整批(它是最灵敏的探针)', () => {
    const r = validateTrustedFacts({ ...HEALTHY_FACTS, sourceName: "按研究方向查看:" });
    expect(r.ok).toBe(false);
    expect(r.drift).toBe(true);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].field).toBe("sourceName");
    expect(r.rejected[0].rule).toBe("nav_text");
  });

  it("多字段同时异常 → drift=true; 单个数值越界(非年份非文案) → drift=false", () => {
    expect(validateTrustedFacts({ impactFactor: 999, acceptanceRate: 5 }).drift).toBe(true); // 2 个
    const single = validateTrustedFacts({ impactFactor: 999 });
    expect(single.ok).toBe(false);
    expect(single.drift).toBe(false); // 单条脏数据, 告警级别低一档
  });
});

describe("IF 判据: 年份型数值 vs 真实小数 IF 怎么分开", () => {
  it("真实 IF(含 2.026 这种长得像年份的小数)全部放行", () => {
    for (const v of [0.1, 2.026, 2.0261, 4.3, 12.5, 98.4, 254.7]) {
      expect(validateTrustedFacts({ impactFactor: v }).ok).toBe(true);
    }
  });

  it("整数才可能被判年份 —— 2.026 不是整数, 靠这条区分", () => {
    expect(isYearLike(2.026)).toBe(false);
    expect(isYearLike(2026)).toBe(true);
    expect(isYearLike(1999)).toBe(true);
    expect(isYearLike(2100)).toBe(true);
    expect(isYearLike(2101)).toBe(false); // 出了年份区间就交给 out_of_range 管
    expect(isYearLike(32)).toBe(false);   // 整数 IF(如 32.0)不在年份区间, 不误伤
  });

  it("整数 IF(32 / 100)是合法的, 不会因为『是整数』就被拒", () => {
    expect(validateTrustedFacts({ impactFactor: 32 }).ok).toBe(true);
    expect(validateTrustedFacts({ impactFactor: 100 }).ok).toBe(true);
  });

  it(`上界 ${IF_MAX}: 越界即拒, 并且整个年份区间(1900-2100)都在界外`, () => {
    expect(validateTrustedFacts({ impactFactor: IF_MAX - 0.1 }).ok).toBe(true);
    expect(validateTrustedFacts({ impactFactor: IF_MAX }).ok).toBe(false);
    expect(IF_MAX).toBeLessThan(1900); // 判据自洽性: 年份物理上进不来
  });

  it("0 / 负数 / NaN / Infinity / 字符串数字 全拒", () => {
    for (const v of [0, -1, NaN, Infinity]) {
      expect(validateTrustedFacts({ impactFactor: v as number }).ok).toBe(false);
    }
    expect(validateTrustedFacts({ impactFactor: "abc" as unknown as number }).ok).toBe(false);
  });

  it("字段没抓到(null/undefined) → 不参与校验, 不算异常", () => {
    const r = validateTrustedFacts({ impactFactor: null, partition: undefined });
    expect(r.ok).toBe(true);
    expect(r.checked).toEqual([]);
  });
});

describe("分区判据", () => {
  it("Q1-Q4 / 1-4区 放行", () => {
    for (const v of ["Q1", "q4", "Q3", "2区", "1 区"]) {
      expect(validateTrustedFacts({ partition: v }).ok).toBe(true);
    }
  });

  it("导航文案 / 学科前缀 / 乱码 拒", () => {
    for (const v of ["按研究方向查看:", "更多", "Q5", "医学2区", "1", "SCI", "<td>Q1</td>"]) {
      expect(validateTrustedFacts({ partition: v }).ok).toBe(false);
    }
  });

  it("casPartition: 中科院大类分区形态放行, 页面文案拒", () => {
    for (const v of ["医学2区", "地球科学2区", "2区", "医学1区TOP", "生物学 3区"]) {
      expect(validateTrustedFacts({ casPartition: v }).ok).toBe(true);
    }
    for (const v of ["按研究方向查看:", "更多>>", "Q1", "点击查看分区", "2026"]) {
      expect(validateTrustedFacts({ casPartition: v }).ok).toBe(false);
    }
  });
});

describe("录用率判据(本库口径是 0-1 比值, 不是百分数)", () => {
  it("0-1 之间放行(含 0 与 1)", () => {
    for (const v of [0, 0.05, 0.28, 1]) {
      expect(validateTrustedFacts({ acceptanceRate: v }).ok).toBe(true);
    }
  });

  it("百分数形态(28 / 85)与年份(2026)都拒 —— py 侧已归一化, 到这里 >1 必是解析错", () => {
    for (const v of [28, 85, 101, 2026, -0.1]) {
      expect(validateTrustedFacts({ acceptanceRate: v }).ok).toBe(false);
    }
  });
});

describe("审稿周期判据(折算成天必须落在 0-1000)", () => {
  it("常见写法都能折算并放行", () => {
    expect(parseReviewCycleDays("3个月")).toBe(90);
    expect(parseReviewCycleDays("4-8周")).toBe(56);
    expect(parseReviewCycleDays("平均 3.0 个月")).toBe(90);
    expect(parseReviewCycleDays("30 days")).toBe(30);
    expect(parseReviewCycleDays("1年")).toBe(365);
    for (const v of ["3个月", "4-8周", "2-4个月", "6-10周", "30 days", "1年"]) {
      expect(validateTrustedFacts({ reviewCycle: v }).ok).toBe(true);
    }
  });

  it("裸年份 '2026' 没有时间单位 → 拒(bad_format)", () => {
    expect(parseReviewCycleDays("2026")).toBeNull();
    const r = validateTrustedFacts({ reviewCycle: "2026" });
    expect(r.ok).toBe(false);
    expect(r.rejected[0].rule).toBe("bad_format");
  });

  it("超过 1000 天 / 0 天 → 拒", () => {
    expect(validateTrustedFacts({ reviewCycle: "5年" }).ok).toBe(false);   // 1825 天
    expect(validateTrustedFacts({ reviewCycle: "0个月" }).ok).toBe(false);
    expect(validateTrustedFacts({ reviewCycle: "2年" }).ok).toBe(true);     // 730 天, 罕见但可能
  });

  it("页面文案 / 超 DB 列宽(50) → 拒", () => {
    expect(validateTrustedFacts({ reviewCycle: "按研究方向查看:" }).ok).toBe(false);
    expect(validateTrustedFacts({ reviewCycle: "更多请点击这里3个月" }).ok).toBe(false);
    expect(validateTrustedFacts({ reviewCycle: "3个月".padEnd(60, "啊") }).ok).toBe(false);
  });
});

describe("导航文案识别器本身", () => {
  it("事故文案 + 常见页面元素都识别得出", () => {
    for (const s of [
      "按研究方向查看:", "按学科分类浏览", "更多", "点击查看", "登录后查看",
      "下一页", "返回顶部", "全部期刊", "请选择", "暂无", "N/A", "",
      "  ", "<a href=x>", "期刊&nbsp;列表", "第一列|第二列|第三列", "换\n行",
    ]) {
      expect(looksLikeNavText(s)).toBe(true);
    }
  });

  it("真实刊名不被误伤", () => {
    for (const s of [
      "地理科学进展", "Experimental Hematology & Oncology", "中华医学杂志",
      "Journal of Agricultural and Food Chemistry", "北京大学学报(医学版)",
      "CA-A Cancer Journal for Clinicians",
    ]) {
      expect(looksLikeNavText(s)).toBe(false);
    }
  });
});

describe("健康数据的回归基线(护栏不能把好数据也拦了)", () => {
  it("正常抓取结果全部放行, checked 覆盖到每个字段", () => {
    const r = validateTrustedFacts(HEALTHY_FACTS);
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
    expect(r.drift).toBe(false);
    expect(r.reason).toBe("");
    expect(r.checked.sort()).toEqual(
      ["acceptanceRate", "casPartition", "impactFactor", "partition", "reviewCycle", "sourceName"],
    );
  });

  it("空输入 / null → 视为通过(没数据不是异常, 由调用方的 candidates 判空拦下)", () => {
    expect(validateTrustedFacts({}).ok).toBe(true);
    expect(validateTrustedFacts(null).ok).toBe(true);
    expect(validateTrustedFacts(undefined).ok).toBe(true);
  });
});
