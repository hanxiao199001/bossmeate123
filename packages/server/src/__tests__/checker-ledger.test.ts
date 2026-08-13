/**
 * 检查器台账的自动判定（8-14 Phase 1）。
 *
 * 台账的全部价值是**可信**，所以这组测试锁的是「什么时候有资格下结论」：
 * 门槛没锁住，第一份周报递到老韩手上就是一页错建议。
 */
import { describe, it, expect } from "vitest";

const L = await import("../services/ops/checker-ledger.js");
const R = await import("../services/ops/checker-registry.js");

const stats = (o: Partial<Parameters<typeof L.judge>[0]> & { checkerId: string }) => ({
  evaluated: 0,
  hits: 0,
  confirmedTrue: 0,
  confirmedFalse: 0,
  confirmedMiss: 0,
  adjudicated: 0,
  hitRate: null,
  ...o,
});

describe("① 已裁决门槛：没数据就不许下结论", () => {
  /**
   * 🔴 执行顺序上 Phase 3（人工反馈入口）晚于台账，前两周 confirmedTrue 对**每个** checker 恒为 0。
   * 没有这条门槛，所有命中过 20 次的闸 —— 包括正在正常干活的反编造四道闸 —— 都会被建议降级。
   * 「没有被确认为真」不等于「被确认为假」。
   */
  it("命中 500 条但零裁决 → 不评价，绝不建议降级", () => {
    const v = L.judge(stats({ checkerId: "fabrication_body", evaluated: 5000, hits: 500, hitRate: 0.1 }));
    expect(v.level).toBe("info");
    expect(v.action).toBeNull();
    expect(v.message).toContain("台账未成熟");
  });

  it("已裁决 9 条（差 1 条到门槛）→ 仍不评价", () => {
    const v = L.judge(
      stats({ checkerId: "fabrication_body", evaluated: 1000, hits: 100, confirmedFalse: 9, adjudicated: 9, hitRate: 0.1 }),
    );
    expect(v.action).toBeNull();
  });

  it("已裁决 10 条且真阳性 0 → 才建议降级", () => {
    const v = L.judge(
      stats({ checkerId: "fabrication_body", evaluated: 1000, hits: 100, confirmedFalse: 10, adjudicated: 10, hitRate: 0.1 }),
    );
    expect(v.level).toBe("suggest");
    expect(v.action).toContain("降级");
  });
});

describe("② 常数判据是唯一不需要裁决数据的一条", () => {
  /**
   * 命中率 >95% 本身就是证据：一个几乎对所有输入都报警的检查器，
   * 无论那些命中真假，它都没有判别力。（教训来源：「连续N段无图」曾 100% 命中。）
   */
  it("命中率 99% + 零裁决 → 照样报警", () => {
    const v = L.judge(stats({ checkerId: "x", evaluated: 100, hits: 99, hitRate: 0.99 }));
    expect(v.level).toBe("warn");
    expect(v.message).toContain("零判别力");
  });

  it("样本太少（evaluated<20）不算常数判据 —— 防止刚上线就被判死", () => {
    const v = L.judge(stats({ checkerId: "x", evaluated: 5, hits: 5, hitRate: 1 }));
    expect(v.level).not.toBe("warn");
  });
});

describe("③ 影子闸升回主动闸", () => {
  it("影子闸攒够 2 条真阳性 → 建议升回", () => {
    const v = L.judge(
      stats({ checkerId: "membership_wording", evaluated: 300, hits: 12, confirmedTrue: 2, confirmedFalse: 9, adjudicated: 11 }),
    );
    expect(v.action).toContain("升回");
  });

  it("影子闸零真阳性 → 不建议升，也不重复建议降级（它已经是影子了）", () => {
    const v = L.judge(
      stats({ checkerId: "membership_wording", evaluated: 300, hits: 40, confirmedFalse: 15, adjudicated: 15 }),
    );
    expect(v.action).toBeNull();
  });
});

describe("④ 长期零命中：提示而非判死", () => {
  it("评估 200+ 次零命中 → info 级提示，措辞要说明安全闸本就该安静", () => {
    const v = L.judge(stats({ checkerId: "placeholder_asset_in_body", evaluated: 500, hits: 0, adjudicated: 10, confirmedFalse: 10, hitRate: 0 }));
    expect(v.level).toBe("info");
    expect(v.action).toContain("安静");
  });
});

describe("⑤ 周聚合键", () => {
  it("同一周内的不同日期归到同一个周一", () => {
    const mon = L.weekStart(new Date("2026-08-10T00:00:00Z")); // 周一
    expect(L.weekStart(new Date("2026-08-14T23:59:00Z"))).toBe(mon);
    expect(L.weekStart(new Date("2026-08-16T12:00:00Z"))).toBe(mon); // 周日
    expect(L.weekStart(new Date("2026-08-17T00:00:00Z"))).not.toBe(mon); // 下周一
  });
});

describe("⑥ 注册处：回溯案例与上线后统计分开", () => {
  /**
   * 排名闸「2 报 2 中」严格说是：该闸存在之后命中 1 次，另 1 例是它诞生前
   * 从措辞闸误报堆里翻出的动机案例。两例都真，但一个是回溯的。
   * 证据的时间归属从第一天起就得干净。
   */
  it("motivatingCases 只描述上线前，不进任何计数", () => {
    const r = R.getChecker("ranking_claim");
    expect(r?.motivatingCases?.[0]?.source).toContain("回溯");
    // 注册处里没有任何计数字段 —— 活数据只能来自 checker_ledger
    expect(Object.keys(r ?? {})).not.toContain("hits");
    expect(Object.keys(r ?? {})).not.toContain("evaluated");
  });

  it("影子闸必须写明降级原因与升回条件", () => {
    for (const c of R.listCheckers().filter((c) => c.mode === "shadow")) {
      expect(c.shadowReason, `${c.id} 是影子却没写原因`).toBeTruthy();
      expect(c.shadowReason!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.shadowReason!.promoteWhen.length).toBeGreaterThan(4);
    }
  });

  it("每个检查器都有上线日期（台账统计的起点）", () => {
    for (const c of R.listCheckers()) expect(c.since, `${c.id} 缺 since`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("⑦ 接线完整性：闸的每个 code 都要有对应的注册项", () => {
  /**
   * 🔴 8-14 首版栽在这里：`placeholder_asset_in_body` 注册成了裸名，
   * 而接线按 `output_health.` 前缀过滤 —— 于是它**永远不会记账**，
   * 而日志里的 `wired codes:9` 看起来完全正常（闸实际有 10 个 code）。
   * 少记一个 checker 不会报错，只会让台账悄悄缺一块 —— 正是这套系统要消灭的形态。
   */
  it("output-health 的每个 code 都能在注册处找到（前缀齐全）", async () => {
    const oh = await import("../services/publisher/output-health.js");
    // 用一组必然全命中的输入把所有 code 逼出来太脆；直接取类型联合的实际取值：
    const codes = [
      "ai_fallback_text", "title_empty", "title_too_short", "title_placeholder",
      "body_too_short", "body_truncated", "body_repetition", "template_residue",
      "fallback_phrase", "placeholder_asset_in_body",
    ];
    const registered = new Set(R.listCheckers().map((c) => c.id));
    const missing = codes.filter((c) => !registered.has(`output_health.${c}`));
    expect(missing, `这些 code 没注册(或缺前缀)，将永远不记账：${missing.join(", ")}`).toEqual([]);
    expect(typeof oh.checkOutputHealth).toBe("function");
  });
});
