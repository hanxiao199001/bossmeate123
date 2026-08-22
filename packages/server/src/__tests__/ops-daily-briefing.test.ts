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
  /**
   * 8-23: `db.execute`(原生 SQL)的返回队列。
   * 原来这个 harness 根本没 mock execute —— 用原生 SQL 的收集器一调就抛,
   * 被自己的 catch 吞掉, **测试绿而那段代码从来没真跑过**(同一天在
   * draft-distributor 的 harness 上踩过一次)。
   */
  const executeQueue: Array<{ rows: Row[] } | Error> = [];
  return { selectQueue, chain, executeQueue };
});

vi.mock("../models/db.js", () => ({
  db: {
    select: () => h.chain(h.selectQueue.shift() ?? []),
    // 8-02: collectZeroStreakPlatform 用 selectDistinct 查"有可分发账号的租户"
    selectDistinct: () => h.chain(h.selectQueue.shift() ?? []),
    insert: () => h.chain([]),
    execute: async () => {
      const next = h.executeQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? { rows: [] };
    },
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
  judgeZeroStreak,
  renderBriefingText,
  worstLevel,
  collectTenantBriefing,
  collectZeroStreakPlatform,
  collectTruncationItems,
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
  manualAccounts: 0,
  manualPendingUpload: 0,
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
    }).items;
    expect(err[0]?.level).toBe("alert");
    expect(err[0]?.text).toContain("db");

    const deg = judgePlatform({
      health: { status: "degraded", timestamp: "", checks: { disk: { status: "warn" } } },
      supplier: OK_SUPPLIER,
      incidents: [],
    }).items;
    expect(deg[0]?.level).toBe("warn");
  });

  it("记账失败事件 → 红色(钱花了没记上账)", () => {
    const { items } = judgePlatform({
      health: { status: "ok", timestamp: "", checks: {} },
      supplier: OK_SUPPLIER,
      incidents: [{ kind: "ledger_write_failed", count: 3, lastMessage: "扣费 1.65 元(dvh)未记上账", lastAt: new Date() }],
    });
    expect(items[0]?.level).toBe("alert");
    expect(items[0]?.text).toContain("3 次");
  });

  it("llm_quota 事件不重复刷屏(已由供应商判定覆盖)", () => {
    const { items } = judgePlatform({
      health: { status: "ok", timestamp: "", checks: {} },
      supplier: { ...OK_SUPPLIER, level: "alert", llmQuotaErrors24h: 2, reasons: ["AI 调用近 24h 报了 2 次「额度不足/欠费」"] },
      incidents: [{ kind: "llm_quota", count: 2, lastMessage: "x", lastAt: new Date() }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toContain("额度不足");
  });

  // ---- 7-27 质检三态归因: 语义各归各, 尤其 degraded ≠ "没评上分"(交接修正项) ----
  const OK_HEALTH = { status: "ok" as const, timestamp: "", checks: {} };

  it("quality_check_degraded = 出了分照常走 → info(知道就行), 绝不能写成'没评上分/进不了草稿箱'", () => {
    const { items } = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "quality_check_degraded", count: 8, lastMessage: "x", lastAt: new Date() }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.level).toBe("info");
    expect(items[0]?.text).toContain("照常");
    expect(items[0]?.text).toContain("抽检");
    expect(items[0]?.text).not.toContain("没评上分");
    expect(items[0]?.text).not.toContain("进不了草稿箱");
  });

  it("quality_check_unavailable = 真没评上分 → ≥5 红色 + 进待办; <5 黄色", () => {
    const big = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "quality_check_unavailable", count: 20, lastMessage: "x", lastAt: new Date() }],
    });
    expect(big.items[0]?.level).toBe("alert");
    expect(big.items[0]?.text).toContain("20 篇没评上分");
    expect(big.items[0]?.text).toContain("进不了草稿箱");
    expect(big.todos.some((t) => t.includes("20 条没评上分待复核"))).toBe(true);

    const small = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "quality_check_unavailable", count: 2, lastMessage: "x", lastAt: new Date() }],
    });
    expect(small.items[0]?.level).toBe("warn");
  });

  it("quality_check_timeout = 过程量(随后自动降级重评) → 少量 info, 大量 warn, 不喊'进不了草稿箱'", () => {
    const few = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "quality_check_timeout", count: 2, lastMessage: "x", lastAt: new Date() }],
    });
    expect(few.items[0]?.level).toBe("info");
    const many = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "quality_check_timeout", count: 20, lastMessage: "x", lastAt: new Date() }],
    });
    expect(many.items[0]?.level).toBe("warn");
    expect(many.items[0]?.text).not.toContain("进不了草稿箱");
  });

  it("llm_cost_cap 熔断 → 红色置顶, 带熔断原因原文", () => {
    const { items } = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "llm_cost_cap", count: 1, lastMessage: "今日 AI 调用已花 52.10 元, 触达日花费硬上限 50 元 —— 已停止内容生成", lastAt: new Date() }],
    });
    expect(items[0]?.level).toBe("alert");
    expect(items[0]?.text).toContain("硬上限 50 元");
  });

  it("llm_timeout 节流事件 → warn, 明说 count 是'波数'", () => {
    const { items } = judgePlatform({
      health: OK_HEALTH, supplier: OK_SUPPLIER,
      incidents: [{ kind: "llm_timeout", count: 3, lastMessage: "This operation was aborted", lastAt: new Date() }],
    });
    expect(items[0]?.level).toBe("warn");
    expect(items[0]?.text).toContain("3 波");
  });
});

describe("7-27 manual 号(人工上传) — 简报口径", () => {
  it("有待上传 → 进待办段, 不产异常条目", () => {
    const { items, todos } = judgeTenant({
      ...HEALTHY_SIGNALS,
      manualAccounts: 14,
      manualPendingUpload: 9,
    });
    expect(items).toHaveLength(0); // 待上传是活儿不是故障
    expect(todos.some((t) => t.includes("9 条内容已生成待下载上传") && t.includes("14 个人工号"))).toBe(true);
  });

  it("登录失效的号 → 同时进待办(要重新扫码)与告警", () => {
    const { items, todos } = judgeTenant({
      ...HEALTHY_SIGNALS,
      accounts: { total: 5, abnormal: 2, byHealth: { login_expired: 2, healthy: 3 } },
    });
    expect(todos.some((t) => t.includes("2 个号登录失效要重新扫码"))).toBe(true);
    expect(items.find((i) => i.text.includes("账号异常"))?.level).toBe("alert");
  });

  it("manual 号积压(manual_upload_stale)计入账号异常黄色; agent_offline 若出现仍照报(auto 号)", () => {
    const stale = judgeTenant({
      ...HEALTHY_SIGNALS,
      accounts: { total: 5, abnormal: 1, byHealth: { manual_upload_stale: 1, healthy: 4 } },
    });
    const hit = stale.items.find((i) => i.text.includes("账号异常"));
    expect(hit?.level).toBe("warn");
    expect(hit?.text).toContain("积压");
  });
});

describe("7-27 judgeZeroStreak — 连续异常升级", () => {
  const day = (generated: number, distributed: number) => ({ generated, distributed });

  it("连续 3 天零产出 → 🚨 红色强告警", () => {
    const items = judgeZeroStreak([day(0, 0), day(0, 0), day(0, 0)], 3);
    expect(items).toHaveLength(1);
    expect(items[0]!.level).toBe("alert");
    expect(items[0]!.text).toContain("🚨");
    expect(items[0]!.text).toContain("连续 3 天零产出");
  });

  it("今天零但昨天有产出 → 不升级(单日偶发交给普通红条)", () => {
    expect(judgeZeroStreak([day(0, 0), day(12, 5), day(10, 4)], 3)).toHaveLength(0);
  });

  it("有生成但连续 3 天零分发 → 🚨 零分发告警(钱照烧内容没出去)", () => {
    const items = judgeZeroStreak([day(10, 0), day(8, 0), day(12, 0)], 3);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("零分发");
  });

  it("窗口不满 N 天(新租户) → 宁可不喊", () => {
    expect(judgeZeroStreak([day(0, 0), day(0, 0)], 3)).toHaveLength(0);
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

  // ===== 8-02 判据由"总额比"改为"元/篇比"。下面三条用的是生产实测数字, 不是编的 =====

  it("🔴 总额下滑但单位成本正常 → 不报(08-02 那条假黄的原型)", () => {
    // 实测 08-02: 今日 4.38 元/28 篇, 近 7 日均 29.45 元/58.6 篇(前一天一次性跑了 219 篇把基准抬高)。
    // 旧口径 4.38/29.45 = 15% → 报警; 新口径 0.156 vs 0.503 元/篇 = 31% → 不报。
    const r = judgeSupplier({
      ...BASE, aliyunAvailableYuan: null,
      avg7dCents: 2945, todayCents: 438, avg7dContents: 58.6, todayContents: 28,
      llmQuotaErrors24h: 0,
    });
    expect(r.level).toBe("ok");
    expect(r.reasons).toHaveLength(0);
  });

  it("单位成本真骤降 → 黄(同样产量花得异常少 = AI 调用大量失败)", () => {
    // 实测 07-25: 0.41 元出 27 篇 = 0.015 元/篇, 而近 7 日均 13.26 元/22 篇 = 0.60 元/篇 → 2.5%
    const r = judgeSupplier({
      ...BASE, aliyunAvailableYuan: null,
      avg7dCents: 1326, todayCents: 41, avg7dContents: 22, todayContents: 27,
      llmQuotaErrors24h: 0,
    });
    expect(r.level).toBe("warn");
    expect(r.reasons.some((x) => x.includes("单位成本"))).toBe(true);
  });

  it("产量太小不做单位成本判定(小分母噪音极大, 那种日子归 low_output 管)", () => {
    const r = judgeSupplier({
      ...BASE, aliyunAvailableYuan: null,
      avg7dCents: 5000, todayCents: 10, avg7dContents: 30, todayContents: 2,   // 今日只出 2 篇 < 5
      llmQuotaErrors24h: 0,
    });
    expect(r.level).toBe("ok");
  });

  it("🔴 断流(今日 0 元)仍然是红 —— 归一化绝不能把 0/0 判成正常", () => {
    // 这是 BSS 权限没配通期间**唯一**的欠费探针, 与产量无关, 改动必须不碰它
    const r = judgeSupplier({
      ...BASE, aliyunAvailableYuan: null,
      avg7dCents: 5000, todayCents: 0, avg7dContents: 30, todayContents: 0,
      llmQuotaErrors24h: 0,
    });
    expect(r.level).toBe("alert");
    expect(r.reasons.some((x) => x.includes("疑似欠费"))).toBe(true);
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
    todos: [] as string[],
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
    todos: [] as string[],
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

  it("7-27 待办段: 🔴 之后 🟡 之前; info 段单独一节'知道就行'", () => {
    const txt = renderBriefingText("2026-07-27", platform, [{
      ...tenantBrief,
      items: [
        { level: "alert" as const, text: "公众号 token 全挂" },
        { level: "warn" as const, text: "1 个公众号未达保底" },
        { level: "info" as const, text: "8 篇的质检分来自降级快模型" },
      ],
      todos: ["9 条内容已生成待下载上传(14 个人工号)", "2 个号登录失效要重新扫码"],
    }]);
    expect(txt.indexOf("🔴")).toBeLessThan(txt.indexOf("📋 今日待办"));
    expect(txt.indexOf("📋 今日待办")).toBeLessThan(txt.indexOf("🟡"));
    expect(txt.indexOf("🟡")).toBeLessThan(txt.indexOf("ℹ️ 知道就行"));
    expect(txt).toContain("9 条内容已生成待下载上传");
    expect(txt).toContain("降级快模型");
  });

  it("7-27 有 🚨 条目 → 标题切换为强告警版(和普通简报一眼区分)", () => {
    const txt = renderBriefingText("2026-07-27", platform, [{
      ...tenantBrief,
      items: [{ level: "alert" as const, text: "🚨【连续 3 天零产出】生成链路已停摆" }],
    }]);
    expect(txt.startsWith("🚨🚨【BossMate 强告警")).toBe(true);
    const normal = renderBriefingText("2026-07-27", platform, [tenantBrief]);
    expect(normal.startsWith("【BossMate 运维简报】")).toBe(true);
  });

  it("info 条目不把整体级别顶成异常(worstLevel 视同 ok)", () => {
    expect(worstLevel([{ level: "info" }])).toBe("ok");
    expect(worstLevel([{ level: "info" }, { level: "warn" }])).toBe("warn");
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
    // ⑥ 租户配置(createdAt=刚创建 → 跳过"连续异常"统计, 不占用后续 select 队列)
    h.selectQueue.push([{ config: { budgetConfig: { dailyLimitYuan: 100 } }, createdAt: new Date() }]);

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
    for (let i = 0; i < 5; i++) h.selectQueue.push([]);
    h.selectQueue.push([{ config: null, createdAt: new Date() }]); // 新租户 → 跳过连续异常统计
    const b = await collectTenantBriefing("t1", "空租户");
    expect(b.generatedToday).toBe(0);
    expect(b.draftShortfalls).toHaveLength(0);
    expect(b.level).toBe("alert");
    expect(b.items.some((i) => i.text.includes("0 篇"))).toBe(true);
  });

  it("7-27 manual 号的任务不进 stuckPending(人工号没人领单是常态, 不是客户端掉线)", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000);
    h.selectQueue.push([{ count: 5 }]);                                   // ① 生成
    h.selectQueue.push([                                                   // ② 任务: manual 的 pending 不算卡住
      { status: "pending", createdAt: old, publishMode: "manual" },
      { status: "pending", createdAt: old, publishMode: "manual" },
      { status: "pending", createdAt: old, publishMode: "auto" },
    ]);
    h.selectQueue.push([]);                                                // ③ 草稿箱
    h.selectQueue.push([{ count: 1 }]);                                    // ④ 发布
    h.selectQueue.push([]);                                                // ⑤ 公众号
    h.selectQueue.push([{ config: null, createdAt: new Date() }]);         // ⑥ 租户
    const b = await collectTenantBriefing("t1", "测试租户");
    expect(b.publishHealth.stuckPending).toBe(1); // 只有 auto 那条
  });

  // 8-02: 连续异常升级已搬到平台级。这里只锁"租户级不再产出 🚨"(去重),
  //   🚨 本身的保护搬到下面 collectZeroStreakPlatform 那个 describe, 没有裸删。
  it("8-02 连续异常已搬平台级 → 租户级不再产出 🚨(四个租户刷四遍的病根)", async () => {
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    for (let i = 0; i < 5; i++) h.selectQueue.push([]);
    h.selectQueue.push([{ config: null, createdAt: monthAgo }]);
    const b = await collectTenantBriefing("t1", "停摆租户");
    expect(b.items.some((i) => i.text.includes("🚨"))).toBe(false);
  });
});

describe("8-02 collectZeroStreakPlatform — 连续异常升级(平台级)", () => {
  beforeEach(() => { h.selectQueue.length = 0; });

  it("有可分发租户 + 全平台连续全零 → 🚨 零产出(只出一条, 不再按租户刷屏)", async () => {
    h.selectQueue.push([{ tenantId: "t-real" }]);   // ① 有 1 个租户有 active 微信号
    h.selectQueue.push([]);                          // ② 逐日生成: 空 = 全零
    h.selectQueue.push([]);                          // ③ 逐日分发: 空 = 全零
    const items = await collectZeroStreakPlatform();
    expect(items).toHaveLength(1);
    expect(items[0]!.level).toBe("alert");
    expect(items[0]!.text).toContain("零产出");
  });

  it("🔴 分母排除空壳租户: 全平台无可分发账号 → 一条都不报(否则平台级同样恒真)", async () => {
    h.selectQueue.push([]);   // ① 没有任何租户有 active 微信号
    const items = await collectZeroStreakPlatform();
    expect(items).toEqual([]);
    // 早退, 不该再去查生成/分发(队列没被消费)
    expect(h.selectQueue.length).toBe(0);
  });

  it("统计失败只降级为不升级, 绝不把整份简报拖挂", async () => {
    h.selectQueue.push(new Error("db down"));
    await expect(collectZeroStreakPlatform()).resolves.toEqual([]);
  });
});

/**
 * 8-23 撞顶率常驻检查 —— 行为锁。
 *
 * ▎ 一次性验收任务的问题是：它验完就没了，而它验的那件事会一直有可能坏。
 *
 * 8-22 把 SIX_DIM_MAX_TOKENS 从 4096 抬到 8000（撞顶率实测 26.0%）。
 * 换模型、加 prompt、判据变长都会把这个数顶回去，所以让它每天自己说话。
 *
 * 🔴 本组重点锁的是**三种「没有撞顶」互相可区分**（红线 #14 / #23）——
 * 查询挂了 / 当天零调用 / 真的零撞顶，三者在下游长得一样的话，
 * 这个检查就变成了它自己要防的东西。
 */
describe("撞顶率每日检查", () => {
  beforeEach(() => { h.executeQueue.length = 0; });

  it("正常水位(<5%) → 不占版面", async () => {
    h.executeQueue.push({ rows: [{ calls: 120, capped: 2 }] });   // 1.7%
    expect(await collectTruncationItems(new Date())).toEqual([]);
  });

  it("≥5% → 黄，文案必须带原始两个数(不能只给百分比)", async () => {
    h.executeQueue.push({ rows: [{ calls: 100, capped: 9 }] });
    const items = await collectTruncationItems(new Date());
    expect(items).toHaveLength(1);
    expect(items[0]!.level).toBe("warn");
    expect(items[0]!.text).toContain("9/100");   // 分子分母都在, 读者能自己判断样本量
    expect(items[0]!.text).toContain("9%");
  });

  it("≥20%(回到修复前水位) → 红", async () => {
    h.executeQueue.push({ rows: [{ calls: 100, capped: 31 }] });
    const items = await collectTruncationItems(new Date());
    expect(items[0]!.level).toBe("alert");
  });

  it("🔴 当天零调用 → 说「无从算起」，绝不报 0%", async () => {
    h.executeQueue.push({ rows: [{ calls: 0, capped: 0 }] });
    const items = await collectTruncationItems(new Date());
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("无从算起");
    // 判据是「不许给出一个算出来的比率」，不是「文本里不许出现 0%」——
    // 文案本身写着「不是 0%」是**对的**，那正是在提醒读者别把它当 0。
    // 第一版断言写成 not.toContain("0%") 被自己的文案命中了：
    // **判据钉的是措辞，不是那件事**（红线 #15 的微缩版）。
    expect(items[0]!.text).not.toMatch(/撞顶 \d+\/\d+/);   // 不出现"撞顶 N/M 次"那种成绩单
  });

  it("🔴 查询自己挂了 → 报出来，不许静默当成「没有撞顶」(红线 #23)", async () => {
    h.executeQueue.push(new Error("connection reset"));
    const items = await collectTruncationItems(new Date());
    // 断言**副作用**(真的产出了一条告警), 不是断言"没抛错" —— 后者会绿到底
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("没算出来");
    expect(items[0]!.text).toContain("这不等于没有撞顶");
  });

  it("🔴 口径跟着 SIX_DIM_MAX_TOKENS 走，不是写死 8000(红线 #16: 绑关系不绑常数)", async () => {
    // 预算一旦改动而判据写死, 这个检查就永远报 0% —— 而那正是它该喊的时候
    const { SIX_DIM_MAX_TOKENS } = await import("../services/content-engine/quality-check-v2.js");
    h.executeQueue.push({ rows: [{ calls: 100, capped: 9 }] });
    const items = await collectTruncationItems(new Date());
    expect(items[0]!.text).toContain(String(SIX_DIM_MAX_TOKENS));
  });
});
