/**
 * 7-25 运维告警三件套 — 每日简报汇总逻辑单测 (mock db, 同 kf-stats 的 drizzle 链式 thenable 模式)。
 *
 * 锁定行为:
 *   1. 判定分级: 零产出=红、产出低于目标=黄、发布卡住/登录失效=红、预算用满=红、80%=黄
 *   2. "只报异常不报流水账": 一切正常时 items 为空(概况另行渲染, 不进告警区)
 *   3. 渲染: 红色置顶 → 黄色 → 概况; 全正常时出"✅ 一切正常"
 *   4. collectTenantBriefing 从 db 聚合的字段口径(生成数/草稿箱达标/发布健康/成本)
 *   5. 供应商余额降级判定: LLM 额度错误=红(铁证) > 余额低于线 > 消耗骤停; 低消耗租户不误报
 *   6. isQuotaLikeError 关键词识别(额度不足 vs 普通限流)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const selectQueue: Array<Row[] | Error> = [];

  // drizzle 链式 thenable: 任意链式调用返回自身, await 时按队列出结果
  function chain(result: Row[] | Error) {
    const target: Promise<Row[]> = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    target.catch(() => {});
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
  db: {
    select: () => h.chain(h.selectQueue.shift() ?? []),
    insert: () => h.chain([]),
  },
  testConnection: vi.fn(async () => true),
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// 阿里云 SDK: 简报测试用不到真调用, mock 掉避免加载真包
vi.mock("@alicloud/openapi-client", () => ({ default: class {}, Config: class {}, Params: class {}, OpenApiRequest: class {} }));
vi.mock("@alicloud/tea-util", () => ({ RuntimeOptions: class {} }));
vi.mock("@alicloud/credentials", () => ({ default: class {}, Config: class {} }));
// 企微推送 / 客服统计 / 账号矩阵: 各自已有独立测试, 这里只关心简报怎么用它们
vi.mock("../services/work-wechat/kf-client.js", () => ({ notifyStaff: vi.fn(async () => true) }));
vi.mock("../services/work-wechat/kf-stats.js", () => ({
  getKfStats: vi.fn(async () => ({
    today: { handoffs: 0, blockedSensitive: 0, customerMessages: 0 },
  })),
}));
vi.mock("../services/metrics/matrix-overview.js", () => ({
  getMatrixOverview: vi.fn(async () => ({
    summary: { totalAccounts: 2, abnormalAccounts: 0 },
    accounts: [{ health: "healthy" }, { health: "healthy" }],
  })),
}));
vi.mock("../services/billing/cost-ledger.js", () => ({
  getSpend: vi.fn(async () => ({ todayCents: 1230, monthCents: 45600 })),
}));

const {
  judgeTenant,
  judgePlatform,
  renderBriefingText,
  worstLevel,
  collectTenantBriefing,
} = await import("../services/ops/daily-briefing.js");
const { judgeSupplier } = await import("../services/ops/supplier-balance.js");
const { isQuotaLikeError } = await import("../services/ops/incidents.js");

// ---- fixtures ----
const HEALTHY_SIGNALS = {
  generatedToday: 10,
  draftPushedToday: 6,
  publishedToday: 4,
  draftShortfalls: [] as Array<{ accountName: string; pushed: number; target: number }>,
  draftTargetPerAccount: 2,
  publishHealth: { stuckPending: 0, loginExpired: 0, failed: 0 },
  kf: { handoffs: 0, blockedSensitive: 0, customerMessages: 12 },
  spend: { todayCents: 1000, monthCents: 20000, budget: {} as { dailyLimitYuan?: number; monthlyLimitYuan?: number } },
  accounts: { total: 3, abnormal: 0, byHealth: { healthy: 3 } as Record<string, number> },
  minDailyContent: 5,
  budgetWarnPct: 80,
  handoffWarnCount: 5,
};

beforeEach(() => {
  h.selectQueue.length = 0;
  vi.clearAllMocks();
});

describe("judgeTenant — 只报异常, 不报流水账", () => {
  it("一切正常 → 零告警条目(概况不进告警区)", () => {
    const { items } = judgeTenant({ ...HEALTHY_SIGNALS });
    expect(items).toHaveLength(0);
  });

  it("零产出 → 红色告警(系统停摆的第一信号)", () => {
    const { items } = judgeTenant({ ...HEALTHY_SIGNALS, generatedToday: 0 });
    expect(items.some((i) => i.level === "alert" && i.text.includes("0 篇"))).toBe(true);
  });

  it("产出低于目标但非零 → 黄色, 不是红色", () => {
    const { items } = judgeTenant({ ...HEALTHY_SIGNALS, generatedToday: 2, minDailyContent: 5 });
    const hit = items.find((i) => i.text.includes("只生成 2 篇"));
    expect(hit?.level).toBe("warn");
    expect(items.every((i) => i.level !== "alert")).toBe(true);
  });

  it("发布卡住 / 登录失效 → 红色; 单纯失败 → 黄色", () => {
    const { items } = judgeTenant({
      ...HEALTHY_SIGNALS,
      publishHealth: { stuckPending: 2, loginExpired: 1, failed: 3 },
    });
    expect(items.find((i) => i.text.includes("没被领取"))?.level).toBe("alert");
    expect(items.find((i) => i.text.includes("登录态失效"))?.level).toBe("alert");
    expect(items.find((i) => i.text.includes("发布失败"))?.level).toBe("warn");
  });

  it("每号保底未达标 → 黄色, 带号名与实际/目标", () => {
    const { items } = judgeTenant({
      ...HEALTHY_SIGNALS,
      draftShortfalls: [{ accountName: "学术加油站", pushed: 1, target: 2 }],
    });
    const hit = items.find((i) => i.text.includes("未达保底"));
    expect(hit?.level).toBe("warn");
    expect(hit?.text).toContain("学术加油站(1/2)");
  });

  it("预算: 80% → 黄色; 用满 100% → 红色(预算闸已经在拦花钱动作)", () => {
    const warn = judgeTenant({
      ...HEALTHY_SIGNALS,
      spend: { todayCents: 8500, monthCents: 0, budget: { dailyLimitYuan: 100 } },
    });
    expect(warn.usedPct).toBe(85);
    expect(warn.items.find((i) => i.text.includes("预算的"))?.level).toBe("warn");

    const alert = judgeTenant({
      ...HEALTHY_SIGNALS,
      spend: { todayCents: 10500, monthCents: 0, budget: { dailyLimitYuan: 100 } },
    });
    expect(alert.items.find((i) => i.text.includes("已用满"))?.level).toBe("alert");
  });

  it("账号授权/登录失效 → 红色; 只是闲置 → 黄色; no_content_today 不单独刷屏", () => {
    const hard = judgeTenant({
      ...HEALTHY_SIGNALS,
      accounts: { total: 3, abnormal: 1, byHealth: { token_invalid: 1, healthy: 2 } },
    });
    expect(hard.items.find((i) => i.text.includes("账号异常"))?.level).toBe("alert");

    const soft = judgeTenant({
      ...HEALTHY_SIGNALS,
      accounts: { total: 3, abnormal: 1, byHealth: { idle_3d: 1, healthy: 2 } },
    });
    expect(soft.items.find((i) => i.text.includes("账号异常"))?.level).toBe("warn");

    const quiet = judgeTenant({
      ...HEALTHY_SIGNALS,
      accounts: { total: 3, abnormal: 1, byHealth: { no_content_today: 1, healthy: 2 } },
    });
    expect(quiet.items.some((i) => i.text.includes("账号异常"))).toBe(false);
  });

  it("AI 客服转人工达阈值 / 敏感词拦截 → 黄色", () => {
    const { items } = judgeTenant({
      ...HEALTHY_SIGNALS,
      kf: { handoffs: 7, blockedSensitive: 2, customerMessages: 30 },
    });
    expect(items.find((i) => i.text.includes("转人工"))?.level).toBe("warn");
    expect(items.find((i) => i.text.includes("敏感词"))?.level).toBe("warn");
  });
});

describe("judgePlatform — 系统健康 + 供应商 + 事件流水", () => {
  const OK_SUPPLIER = {
    aliyunAvailableYuan: null, aliyunCurrency: null, aliyunError: null,
    avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0,
    level: "ok" as const, reasons: [] as string[],
  };

  it("health=error → 红; degraded → 黄", () => {
    const err = judgePlatform({
      health: { status: "error", timestamp: "", checks: { db: { status: "error" }, redis: { status: "ok" } } },
      supplier: OK_SUPPLIER,
      incidents: [],
    });
    expect(err[0]?.level).toBe("alert");
    expect(err[0]?.text).toContain("db");

    const deg = judgePlatform({
      health: { status: "degraded", timestamp: "", checks: { disk: { status: "warn" } } },
      supplier: OK_SUPPLIER,
      incidents: [],
    });
    expect(deg[0]?.level).toBe("warn");
  });

  it("记账失败事件 → 红色(钱花了没记上账)", () => {
    const items = judgePlatform({
      health: { status: "ok", timestamp: "", checks: {} },
      supplier: OK_SUPPLIER,
      incidents: [{ kind: "ledger_write_failed", count: 3, lastMessage: "扣费 1.65 元(dvh)未记上账", lastAt: new Date() }],
    });
    expect(items[0]?.level).toBe("alert");
    expect(items[0]?.text).toContain("3 次");
  });

  it("llm_quota 事件不重复刷屏(已由供应商判定覆盖)", () => {
    const items = judgePlatform({
      health: { status: "ok", timestamp: "", checks: {} },
      supplier: { ...OK_SUPPLIER, level: "alert", llmQuotaErrors24h: 2, reasons: ["AI 调用近 24h 报了 2 次「额度不足/欠费」"] },
      incidents: [{ kind: "llm_quota", count: 2, lastMessage: "x", lastAt: new Date() }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toContain("额度不足");
  });
});

describe("judgeSupplier — 不依赖外部 API 的降级判定", () => {
  const BASE = { warnYuan: 200, alertYuan: 50, dropRatio: 0.2, minAvgCents: 100 };

  it("LLM 明确报额度不足 → 红(最硬信号)", () => {
    const r = judgeSupplier({ ...BASE, aliyunAvailableYuan: null, avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 3 });
    expect(r.level).toBe("alert");
    expect(r.reasons[0]).toContain("额度不足");
  });

  it("平时天天花钱、今天骤降到 0 → 红(疑似欠费/额度耗尽)", () => {
    const r = judgeSupplier({ ...BASE, aliyunAvailableYuan: null, avg7dCents: 5000, todayCents: 0, llmQuotaErrors24h: 0 });
    expect(r.level).toBe("alert");
    expect(r.reasons.some((x) => x.includes("疑似欠费"))).toBe(true);
  });

  it("消耗大幅下滑但没到 0 → 黄", () => {
    const r = judgeSupplier({ ...BASE, aliyunAvailableYuan: null, avg7dCents: 5000, todayCents: 500, llmQuotaErrors24h: 0 });
    expect(r.level).toBe("warn");
  });

  it("本来就不怎么花钱的租户不误报", () => {
    const r = judgeSupplier({ ...BASE, aliyunAvailableYuan: null, avg7dCents: 50, todayCents: 0, llmQuotaErrors24h: 0 });
    expect(r.level).toBe("ok");
    expect(r.reasons).toHaveLength(0);
  });

  it("账户余额: 低于提醒线=黄, 低于告警线=红", () => {
    expect(judgeSupplier({ ...BASE, aliyunAvailableYuan: 150, avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0 }).level).toBe("warn");
    expect(judgeSupplier({ ...BASE, aliyunAvailableYuan: 30, avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0 }).level).toBe("alert");
    expect(judgeSupplier({ ...BASE, aliyunAvailableYuan: 800, avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0 }).level).toBe("ok");
  });
});

describe("isQuotaLikeError — 额度不足 vs 普通失败", () => {
  it("命中额度/欠费关键词", () => {
    expect(isQuotaLikeError(400, '{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isQuotaLikeError(403, "AccessDenied.Unpurchased")).toBe(true);
    expect(isQuotaLikeError(429, "Free allocated quota exceeded")).toBe(true);
    expect(isQuotaLikeError(402, "")).toBe(true);
    expect(isQuotaLikeError(400, "账户余额不足，请充值")).toBe(true);
  });
  it("普通限流/参数错误不误判成欠费", () => {
    expect(isQuotaLikeError(429, "Requests rate limit exceeded, please try again later")).toBe(false);
    expect(isQuotaLikeError(400, "Invalid parameter: messages")).toBe(false);
    expect(isQuotaLikeError(500, "")).toBe(false);
  });
});

describe("renderBriefingText — 异常置顶, 正常也发", () => {
  const tenantBrief = {
    tenantId: "t1", tenantName: "测试租户",
    generatedToday: 0, draftPushedToday: 0, publishedToday: 0,
    draftShortfalls: [], draftTargetPerAccount: 2,
    publishHealth: { stuckPending: 0, loginExpired: 0, failed: 0 },
    kf: { handoffs: 0, blockedSensitive: 0, customerMessages: 0 },
    spend: { todayCents: 0, monthCents: 0, budget: {}, usedPct: null },
    accounts: { total: 2, abnormal: 0, byHealth: {} },
    items: [
      { level: "alert" as const, text: "今日内容生成 0 篇" },
      { level: "warn" as const, text: "1 个公众号未达保底" },
    ],
    level: "alert" as const,
  };
  const platform = {
    health: { status: "ok" as const, timestamp: "", checks: {} },
    supplier: {
      aliyunAvailableYuan: 1234.5, aliyunCurrency: "CNY", aliyunError: null,
      avg7dCents: 0, todayCents: 0, llmQuotaErrors24h: 0, level: "ok" as const, reasons: [],
    },
    incidents: [],
    items: [],
    level: "ok" as const,
  };

  it("红色段在黄色段之前, 概况在最后", () => {
    const txt = renderBriefingText("2026-07-25", platform, [tenantBrief]);
    expect(txt.indexOf("🔴")).toBeGreaterThan(-1);
    expect(txt.indexOf("🔴")).toBeLessThan(txt.indexOf("🟡"));
    expect(txt.indexOf("🟡")).toBeLessThan(txt.indexOf("— 今日概况 —"));
    expect(txt).toContain("今日内容生成 0 篇");
    expect(txt).toContain("阿里云账户余额: 1234.50 元");
  });

  it("全正常时也出简报, 并明说'正常'(不发 = 分不清没事还是简报挂了)", () => {
    const txt = renderBriefingText("2026-07-25", platform, [{ ...tenantBrief, items: [], level: "ok" }]);
    expect(txt).toContain("✅ 一切正常");
    expect(txt).toContain("— 今日概况 —");
    expect(txt).not.toContain("🔴");
  });
});

describe("worstLevel", () => {
  it("取最严重的一项", () => {
    expect(worstLevel([])).toBe("ok");
    expect(worstLevel([{ level: "ok" }, { level: "warn" }])).toBe("warn");
    expect(worstLevel([{ level: "warn" }, { level: "alert" }, { level: "ok" }])).toBe("alert");
  });
});

describe("collectTenantBriefing — mock db 聚合口径", () => {
  it("按 select 调用顺序取数: 生成数/任务/草稿箱每号/发布数/公众号/租户配置", async () => {
    // Promise.all 内 db.select 顺序: ①今日生成数 ②agent任务 ③每号草稿箱 ④今日发布数 ⑤公众号账号 ⑥租户配置
    // (getSpend 已 mock, 不占队列)
    h.selectQueue.push([{ count: 12 }]);                                   // ① 生成 12 条
    h.selectQueue.push([                                                    // ② agent 任务: 1 条卡住 + 1 条登录失效
      { status: "pending", createdAt: new Date(Date.now() - 20 * 60 * 1000) },
      { status: "login_expired", createdAt: new Date() },
    ]);
    h.selectQueue.push([{ accountId: "a1", count: 3 }]);                    // ③ a1 推了 3 条草稿
    h.selectQueue.push([{ count: 5 }]);                                     // ④ 今日发布 5 条
    h.selectQueue.push([                                                    // ⑤ 两个公众号, a2 一条没推
      { id: "a1", accountName: "达标号" },
      { id: "a2", accountName: "饿死号" },
    ]);
    h.selectQueue.push([{ config: { budgetConfig: { dailyLimitYuan: 100 } } }]); // ⑥ 日预算 100 元

    const b = await collectTenantBriefing("t1", "测试租户");

    expect(b.generatedToday).toBe(12);
    expect(b.publishedToday).toBe(5);
    expect(b.draftPushedToday).toBe(3);
    // 只有 a2 未达保底(a1 已 3 条 ≥ 2)
    expect(b.draftShortfalls).toHaveLength(1);
    expect(b.draftShortfalls[0]!.accountName).toBe("饿死号");
    // 发布健康复用 matrix-health.computePublishHealth
    expect(b.publishHealth).toEqual({ stuckPending: 1, loginExpired: 1, failed: 0 });
    // 成本走 getSpend(已 mock 1230 分) + 预算 100 元 → 12%
    expect(b.spend.todayCents).toBe(1230);
    expect(b.spend.usedPct).toBe(12);
    // 有红色项(卡住 + 登录失效) → 整体 alert
    expect(b.level).toBe("alert");
  });

  it("空库: 全零不抛, 零产出被判红", async () => {
    for (let i = 0; i < 6; i++) h.selectQueue.push([]);
    const b = await collectTenantBriefing("t1", "空租户");
    expect(b.generatedToday).toBe(0);
    expect(b.draftShortfalls).toHaveLength(0);
    expect(b.level).toBe("alert");
    expect(b.items.some((i) => i.text.includes("0 篇"))).toBe(true);
  });
});
