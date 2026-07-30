/**
 * 7-30 期刊池资源盘点 —— 余量口径单测(mock db)。
 *
 * 锁定的是**口径**, 不是实现:
 *   1. freshVerified = 已核实 且 冷却期内未被该租户用过 = 选刊器第①层真正能选到的本数
 *   2. scope 汇总按 journal_kind: domestic = cn+both, international = intl(骑墙刊不进国外槽位)
 *   3. 综合刊(generic)**不算进学科余量**, 只作为第②层垫子单列 —— 它被算进去就等于承认
 *      "教育号发理工综合刊也行", 那正是 7-21 分层收窄要治的病
 *   4. exhaustedInDays 用净流失(用量 − 冷却回补), 池子是转盘不是水箱
 *   5. 没人用的学科不告警(否则 26 个格子天天刷屏, 真正告急的被淹掉)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const selectQueue: Array<Row[]> = [];
  function chain(result: Row[]) {
    const target: Promise<Row[]> = Promise.resolve(result);
    const proxy: unknown = new Proxy(function () {} as never, {
      get(_t, prop) {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[prop].bind(target);
        }
        return () => proxy;
      },
      apply() { return proxy; },
    });
    return proxy;
  }
  return { selectQueue, chain };
});

vi.mock("../models/db.js", () => ({
  db: { select: () => h.chain(h.selectQueue.shift() ?? []) },
  testConnection: vi.fn(async () => true),
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  buildInventory, estimateExhaustion, getPoolInventory, renderPoolBriefItems,
} = await import("../services/journals/pool-inventory.js");
type Cells = Parameters<typeof buildInventory>[0]["cells"];

const TENANT = "11111111-1111-4111-8111-111111111111";

/** 生产实测那个场景: 国际教育刊全库只有 6 本, 近期天天在排教育选题 */
const EDU_CELLS: Cells = [
  { disciplineCode: "education", journalKind: "intl", total: 6, verified: 6, freshVerified: 0 },
  { disciplineCode: "education", journalKind: "cn", total: 132, verified: 120, freshVerified: 60 },
  { disciplineCode: "generic", journalKind: "intl", total: 100, verified: 80, freshVerified: 12 },
  { disciplineCode: "medicine", journalKind: "intl", total: 800, verified: 700, freshVerified: 400 },
  { disciplineCode: "physics", journalKind: "unknown", total: 704, verified: 0, freshVerified: 0 },
];

function inv(cells: Cells = EDU_CELLS, usage: Array<[string, number]> = [["education|intl", 112]]) {
  return buildInventory({
    tenantId: TENANT, cells, usage: new Map(usage), cooldownDays: 15, usageWindowDays: 14,
  });
}

beforeEach(() => {
  h.selectQueue.length = 0;
  delete process.env.POOL_LOW_WATERMARK_COUNT;
  delete process.env.POOL_LOW_WATERMARK_DAYS;
});

describe("余量口径", () => {
  it("freshVerified 只数**对口学科**的已核实新鲜刊, 综合刊单列不并入", () => {
    const r = inv().rows.find((x) => x.disciplineCode === "education" && x.scope === "international")!;
    expect(r.total).toBe(6);
    expect(r.verified).toBe(6);
    expect(r.freshVerified).toBe(0);       // 6 本全在冷却里 → 第①层一本都选不到
    expect(r.genericFreshVerified).toBe(12); // 第②层还有 12 本综合刊垫着, 但那不是"教育刊"
    expect(r.inCooldown).toBe(6);
  });

  it("scope 汇总按 journal_kind: domestic = cn + both, international = intl(骑墙刊不进国外槽位)", () => {
    const cells: Cells = [
      { disciplineCode: "medicine", journalKind: "cn", total: 10, verified: 8, freshVerified: 5 },
      { disciplineCode: "medicine", journalKind: "both", total: 4, verified: 4, freshVerified: 3 },
      { disciplineCode: "medicine", journalKind: "intl", total: 20, verified: 15, freshVerified: 9 },
    ];
    const rows = inv(cells, []).rows.filter((x) => x.disciplineCode === "medicine");
    const dom = rows.find((x) => x.scope === "domestic")!;
    const intl = rows.find((x) => x.scope === "international")!;
    expect(dom.total).toBe(14);          // cn + both
    expect(dom.freshVerified).toBe(8);   // 5 + 3
    expect(intl.total).toBe(20);         // 骑墙刊(both)**不**进国外槽位
    expect(intl.freshVerified).toBe(9);
  });

  it("kind='unknown' 的刊对任何 scope 都不可见 → 不进任何学科余量, 但单独报出来(补数据第一优先级)", () => {
    const i = inv();
    const phys = i.rows.filter((x) => x.disciplineCode === "physics");
    expect(phys.every((x) => x.total === 0)).toBe(true);
    expect(i.invisibleUnknown).toBe(704);
  });

  it("13 学科 × 2 定位 = 26 行, 无数据的学科也在表里(余量 0 本身就是信息)", () => {
    expect(inv().rows).toHaveLength(26);
  });

  it("按 freshVerified 升序 —— 最该补货的排最前", () => {
    const rows = inv().rows;
    for (let k = 1; k < rows.length; k++) expect(rows[k].freshVerified).toBeGreaterThanOrEqual(rows[k - 1].freshVerified);
  });
});

describe("exhaustedInDays: 池子是转盘不是水箱", () => {
  it("净流失 = 日均用量 − 冷却回补; 回补追得上就判可持续, 不预测枯竭", () => {
    expect(estimateExhaustion({ freshVerified: 10, dailyUsage: 2, replenishPerDay: 0 }))
      .toEqual({ exhaustedInDays: 5, sustainable: false });
    expect(estimateExhaustion({ freshVerified: 10, dailyUsage: 2, replenishPerDay: 1 }))
      .toEqual({ exhaustedInDays: 10, sustainable: false });
    expect(estimateExhaustion({ freshVerified: 10, dailyUsage: 1, replenishPerDay: 1 }))
      .toEqual({ exhaustedInDays: null, sustainable: true });
  });

  it("已经 0 本且还在排产 = 0 天(今天就在降级); 没人用 = 不预测", () => {
    expect(estimateExhaustion({ freshVerified: 0, dailyUsage: 8, replenishPerDay: 0.4 }).exhaustedInDays).toBe(0);
    expect(estimateExhaustion({ freshVerified: 0, dailyUsage: 0, replenishPerDay: 0 }).exhaustedInDays).toBeNull();
  });

  it("教育国际刊实测场景: 6 本全在冷却 + 日均 8 次 → 0 天, 且判定为告警", () => {
    const r = inv().rows.find((x) => x.disciplineCode === "education" && x.scope === "international")!;
    expect(r.dailyUsage).toBe(8);          // 112 / 14
    expect(r.replenishPerDay).toBe(0.4);   // 6 / 15
    expect(r.exhaustedInDays).toBe(0);
    expect(r.low).toBe(true);
  });
});

describe("告警门槛", () => {
  it("没人用的学科不告警 —— 26 个格子里只报真正在消耗的那些", () => {
    const i = inv();
    expect(i.alerts.every((a) => a.dailyUsage > 0)).toBe(true);
    expect(i.alerts.map((a) => `${a.disciplineCode}|${a.scope}`)).toEqual(["education|international"]);
  });

  it("余量低于本数水位线也告警(即使还没到天数水位线)", () => {
    process.env.POOL_LOW_WATERMARK_COUNT = "5";
    const cells: Cells = [{ disciplineCode: "law", journalKind: "intl", total: 400, verified: 300, freshVerified: 4 }];
    // 用量很低(14 天 14 次 = 1/天), 回补 (300-4)/15 ≈ 19.7/天 → 可持续, 但只剩 4 本仍要报
    const r = inv(cells, [["law|intl", 14]]).rows.find((x) => x.disciplineCode === "law" && x.scope === "international")!;
    expect(r.sustainable).toBe(true);
    expect(r.exhaustedInDays).toBeNull();
    expect(r.low).toBe(true);
  });

  it("阈值 env 可配", () => {
    process.env.POOL_LOW_WATERMARK_COUNT = "0";
    process.env.POOL_LOW_WATERMARK_DAYS = "0";
    const cells: Cells = [{ disciplineCode: "law", journalKind: "intl", total: 400, verified: 300, freshVerified: 4 }];
    const r = inv(cells, [["law|intl", 14]]).rows.find((x) => x.disciplineCode === "law" && x.scope === "international")!;
    expect(r.low).toBe(false);
  });
});

describe("简报文案: 运营能照着做, 不是给技术看的", () => {
  it("说清 几本 / 几天 / 到时会怎样 / 可以做什么", () => {
    const { items, todos } = renderPoolBriefItems(inv());
    expect(items).toHaveLength(1);
    expect(items[0].level).toBe("alert"); // 0 本 = 今天就在降级, 红色
    expect(items[0].text).toContain("教育学(国际刊)");
    expect(items[0].text).toContain("只剩 0 本");
    expect(items[0].text).toContain("内容会开始重复或串到别的学科");
    expect(items[0].text).toContain("补该学科期刊数据");
    expect(todos[0]).toContain("补期刊数据");
  });

  it("还剩几本但快见底 = 黄色 + 天数", () => {
    const cells: Cells = [{ disciplineCode: "law", journalKind: "intl", total: 20, verified: 10, freshVerified: 3 }];
    const { items } = renderPoolBriefItems(inv(cells, [["law|intl", 42]])); // 3/天
    expect(items[0].level).toBe("warn");
    expect(items[0].text).toMatch(/只剩 3 本，按当前用量约 \d+ 天后枯竭/);
  });

  it("一切充裕时一条都不报(简报只报异常, 不做流水账)", () => {
    const cells: Cells = [{ disciplineCode: "medicine", journalKind: "intl", total: 800, verified: 700, freshVerified: 400 }];
    expect(renderPoolBriefItems(inv(cells, [["medicine|intl", 14]])).items).toHaveLength(0);
  });
});

describe("getPoolInventory: 两条查询的装配", () => {
  it("池子查询 + 用量查询 → 余量表(用量按 journal_usage 行数, 不是用过几本刊)", async () => {
    h.selectQueue.push([
      { disciplineCode: "education", journalKind: "intl", total: 6, verified: 6, freshVerified: 0 },
      { disciplineCode: "generic", journalKind: "intl", total: 100, verified: 80, freshVerified: 12 },
    ]);
    h.selectQueue.push([{ disciplineCode: "education", journalKind: "intl", uses: 112 }]);
    const i = await getPoolInventory({ tenantId: TENANT, usageWindowDays: 14 });
    const r = i.rows.find((x) => x.disciplineCode === "education" && x.scope === "international")!;
    expect(r.usesInWindow).toBe(112);
    expect(r.dailyUsage).toBe(8);
    expect(r.freshVerified).toBe(0);
    expect(i.alerts[0].disciplineCode).toBe("education");
    expect(i.cooldownDays).toBe(15);
  });
});
