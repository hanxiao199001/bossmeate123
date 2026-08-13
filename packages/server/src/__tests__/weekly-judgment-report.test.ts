/**
 * 判断层周报（8-14 Phase 2）。
 *
 * 验收点只有一条：**研小二能不能不问任何人就照着做。**
 * 所以这组测试锁的不是"字段齐不齐"，是"⑤ 那段是不是人话、是不是她做得了的事"。
 */
import { describe, it, expect } from "vitest";

const W = await import("../services/ops/weekly-judgment-report.js");

const ck = (o: Record<string, unknown>) => ({
  checkerId: "x",
  level: "info" as const,
  message: "",
  action: null,
  hits: 0,
  adjudicated: 0,
  ...o,
});

describe("① ⑤ 待办建议：每条都要能照着做", () => {
  it("最多 3 条 —— 一页给运营 10 条待办等于没给", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      ck({ checkerId: `c${i}`, level: "suggest", action: "建议降级为影子", message: "报 30 条真阳性 0", hits: 30, adjudicated: 12 }),
    );
    const todos = W.pickTodos({ checkers: many, annotated: 0, health: { articles: 10, titleFallback: 3, shortBody: 2, truncated: 1 } });
    expect(todos.length).toBeLessThanOrEqual(3);
  });

  it("每条都必须落在三种运营做得到的动作里", () => {
    const todos = W.pickTodos({
      checkers: [
        ck({ checkerId: "a", level: "suggest", action: "建议降级为影子", message: "m", hits: 30, adjudicated: 12 }),
        ck({ checkerId: "b", level: "warn", message: "命中率 99%", hits: 99, adjudicated: 0 }),
      ],
      annotated: 0,
      health: { articles: 20, titleFallback: 2, shortBody: 5, truncated: 1 },
    });
    expect(todos.length).toBeGreaterThan(0);
    for (const t of todos) {
      expect(["点按钮", "找老板拍板", "提工单给开发"]).toContain(t.kind);
      // 动作要写到"照着做"的粒度，不是一句名词
      expect(t.action.length).toBeGreaterThan(15);
    }
  });

  /**
   * 🔴 这条是整页的红线：出现「调阈值」「改代码」「修改配置文件」这类字样，
   * 说明这页不是写给运营的。宁可这条建议不出现。
   */
  it("建议里不许出现运营做不了的动作", () => {
    const todos = W.pickTodos({
      checkers: [ck({ checkerId: "a", level: "suggest", action: "建议降级为影子", message: "m", hits: 30, adjudicated: 12 })],
      annotated: 0,
      health: { articles: 20, titleFallback: 0, shortBody: 0, truncated: 0 },
    });
    // 🔴「设置页/配置页」在此列 —— 后台**没有**检查器开关页, 也没有阈值页。
    //   指一个不存在的按钮比不给建议更糟: 她会先找半天, 然后再也不信这页。
    //   （哪天真做了那个页面, 再从这个名单里删掉。）
    const forbidden = ["改代码", "调阈值", "修改配置文件", "改 env", "重启", "SQL", "部署", "设置页", "配置页"];
    for (const t of todos) {
      for (const f of forbidden) expect(t.action, `建议里出现了运营做不了的动作「${f}」`).not.toContain(f);
    }
  });

  it("零命中零问题 → 一条建议都不给（没事就别打扰她）", () => {
    const todos = W.pickTodos({
      checkers: [ck({ checkerId: "a", level: "info", message: "ok" })],
      annotated: 5,
      health: { articles: 30, titleFallback: 0, shortBody: 0, truncated: 0 },
    });
    expect(todos).toEqual([]);
  });
});

describe("② 正文过短：有数据才推给老板", () => {
  it("占比 >=20% 且样本够 → 出一条「找老板拍板」，且把两个数都摆出来", () => {
    const todos = W.pickTodos({
      checkers: [],
      annotated: 0,
      health: { articles: 192, titleFallback: 0, shortBody: 50, truncated: 0 },
    });
    const t = todos.find((x) => x.kind === "找老板拍板");
    expect(t).toBeTruthy();
    expect(t!.what).toContain("192");
    expect(t!.what).toContain("50");
    // 🔴 红线 #13：只摆事实与对照基准，不替老板归因
    expect(t!.what).not.toMatch(/多半|可能是因为|typically|说明模型/);
  });

  it("样本太小不推 —— 5 篇里 2 篇短说明不了任何事", () => {
    const todos = W.pickTodos({
      checkers: [],
      annotated: 0,
      health: { articles: 5, titleFallback: 0, shortBody: 2, truncated: 0 },
    });
    expect(todos).toEqual([]);
  });
});

describe("③ 台账未成熟时诚实说不知道", () => {
  /**
   * 第一份周报大概率满屏「台账未成熟」—— 这是正确的，不是尴尬的。
   * 关键是**不许用推测填空**：未成熟的项不产生任何"建议降级/建议升回"。
   */
  it("已裁决不足 → 不产生去留建议，只解释为什么不评价", () => {
    const todos = W.pickTodos({
      checkers: [ck({ checkerId: "a", level: "info", message: "台账未成熟（已裁决 0/10）", hits: 40, adjudicated: 0 })],
      annotated: 0,
      health: { articles: 20, titleFallback: 0, shortBody: 0, truncated: 0 },
    });
    expect(todos).toHaveLength(1);
    expect(todos[0]!.what).toContain("还没人裁决");
    // 明确告诉她"现在不用动作"，而不是留一个悬着的任务
    expect(todos[0]!.action).toContain("无需动作");
  });
});

describe("④ 排序：能做的事优先，解释垫底", () => {
  /**
   * 一页只给 3 条的前提是这 3 条得是最该做的。
   * 「台账未成熟」是一条无需动作的解释 —— 它绝不能把真动作挤出页面。
   */
  it("满员时，无需动作的解释让位给真动作", () => {
    const todos = W.pickTodos({
      checkers: [
        ck({ checkerId: "a", level: "suggest", action: "建议降级为影子", message: "m", hits: 30, adjudicated: 12 }),
        ck({ checkerId: "imm", level: "info", message: "未成熟", hits: 40, adjudicated: 0 }),
      ],
      annotated: 0,
      health: { articles: 192, titleFallback: 8, shortBody: 50, truncated: 0 },
    });
    expect(todos).toHaveLength(3);
    expect(todos.some((t) => t.action.includes("无需动作"))).toBe(false);
    expect(todos.some((t) => t.kind === "找老板拍板")).toBe(true);
  });
});

describe("⑤ 页脚原则", () => {
  it("渲染文本里带着「数据不够比假结论值钱」这句话", async () => {
    const r = await W.buildWeeklyReport().catch(() => null);
    // 连不上库时跳过（本条只验渲染，不验数据）
    if (!r) return;
    expect(r.text).toContain("诚实的「数据不够」比好看的假结论值钱");
    // ⑤ 必须在最前 —— 运营只需读这一段
    expect(r.text.indexOf("这周要你做的事")).toBeLessThan(r.text.indexOf("检查器台账"));
  });
});
