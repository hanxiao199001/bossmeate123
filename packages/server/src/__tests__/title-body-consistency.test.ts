import { describe, it, expect } from "vitest";
import { checkTitleBodyConsistency, sanitizeForCompliance } from "../services/compliance/content-check.js";

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
