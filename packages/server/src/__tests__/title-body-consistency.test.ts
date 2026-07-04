import { describe, it, expect } from "vitest";
import { checkTitleBodyConsistency, checkTitleDataConsistency, sanitizeForCompliance } from "../services/compliance/content-check.js";

describe("checkTitleBodyConsistency (7-03 行7 教训: 标题保录承诺 vs 正文风险信号)", () => {
  it("行7 场景: 标题'稳发' + 正文'CAR 高风险,建议避开' → 不通过", () => {
    const r = checkTitleBodyConsistency(
      "6.1分Cell子刊，审稿20周，青椒毕业稳发！",
      "<p>该刊 CAR 指数属高风险，建议谨慎评估或避开。</p>",
    );
    expect(r.ok).toBe(false);
    expect(r.titleHits).toContain("稳发");
    expect(r.riskSignal).toBeTruthy();
  });

  it("闭眼冲 + 正文有预警名单 → 不通过", () => {
    const r = checkTitleBodyConsistency(
      "IF7.31黑马，毕业党闭眼冲！",
      "<p>该刊已列入预警名单，投前务必确认单位是否认可。</p>",
    );
    expect(r.ok).toBe(false);
    expect(r.titleHits).toContain("闭眼冲");
  });

  it("良性: 标题'闭眼冲' 但正文无风险信号 → 放行(狠话由轮换限量, 不在此拦)", () => {
    const r = checkTitleBodyConsistency(
      "IF10.5+1区化学，审稿快，毕业党闭眼冲！",
      "<p>审稿周期约 1.9 个月，自引率低风险，适合冲。</p>",
    );
    expect(r.ok).toBe(true);
    expect(r.titleHits).toHaveLength(0);
  });

  it("良性: 标题无保录承诺 + 正文有风险 → 放行(标题老实即可)", () => {
    const r = checkTitleBodyConsistency(
      "IF6.1的Cell子刊，投前先看这几点",
      "<p>CAR 高风险，建议避开。</p>",
    );
    expect(r.ok).toBe(true);
  });

  it("sanitizeForCompliance: 正文'稳发'被净化", () => {
    expect(sanitizeForCompliance("这本刊毕业稳发")).not.toContain("稳发");
  });
});

describe("checkTitleDataConsistency (7-05 行1 教训: 标题审稿/录用率数字须正文复现)", () => {
  it("行1 场景: 标题'审稿60天,录用率35%' 正文写'3-4个月/较低' → 不通过", () => {
    const r = checkTitleDataConsistency(
      "IF5.3物理顶刊！审稿60天，录用率35%，闭眼冲！",
      "<p>审稿周期属于标准水平，通常需要3-4个月；录用率较低，竞争激烈。</p>",
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.length).toBeGreaterThanOrEqual(1);
  });

  it("良性: 标题'审稿3.4个月' 正文复现'3.4个月' → 通过", () => {
    const r = checkTitleDataConsistency(
      "IF9.8工程刊，审稿3.4个月，值得投！",
      "<p>该刊平均审稿周期约3.4个月，在工程类算快。</p>",
    );
    expect(r.ok).toBe(true);
  });

  it("良性: 标题无审稿/录用率数字(只有IF/分区) → 不触发", () => {
    const r = checkTitleDataConsistency("IF10.5+1区化学顶刊，毕业党必投！", "<p>影响因子10.5，化学1区。</p>");
    expect(r.ok).toBe(true);
  });

  it("行4 场景(DB硬校验): 标题+正文都写'审稿60天/录用率35%'一致编造, 但 DB 两字段皆空 → 不通过", () => {
    const r = checkTitleDataConsistency(
      "IF5.4环境神刊，审稿60天录用率35%，闭眼冲！",
      "<p>该刊审稿约60天，录用率35%左右。</p>", // 正文复现了(一致编造) → 只有 DB 校验能抓
      { reviewCycle: null, acceptanceRate: null },
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.join()).toMatch(/DB无/);
  });

  it("DB硬校验放行: DB 有审稿周期(20Weeks)且标题正文一致 → 通过", () => {
    const r = checkTitleDataConsistency(
      "审稿20周的Cell子刊",
      "<p>审稿周期约20周。</p>",
      { reviewCycle: "20Weeks", acceptanceRate: null },
    );
    expect(r.ok).toBe(true);
  });
});

describe("7-05 脏点净化", () => {
  it("大类学科叠字: '医学医学2区TOP' → '医学2区TOP'", () => {
    expect(sanitizeForCompliance("中科院分区医学医学2区TOP")).toBe("中科院分区医学2区TOP");
  });
  it("不误伤合法叠词: '看看/常常' 不动", () => {
    expect(sanitizeForCompliance("你可以看看这本，投稿常常被拒")).toBe("你可以看看这本，投稿常常被拒");
  });
});
