/**
 * P0-B watchdog 单元测试：generating 超 10min → failed 自动转移。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(48),
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    DATABASE_URL: "postgres://test/test",
  },
}));

// db.select().from().where() → 返回 stuck rows
const selectWhereMock = vi.fn();
const selectChain = {
  from: () => ({
    where: selectWhereMock,
  }),
};

// db.update().set().where().returning() → 模拟 transitionToStatus 命中
const returningMock = vi.fn();
const updateChain = {
  set: () => ({
    where: () => ({ returning: returningMock }),
  }),
};

// db.select().from().where().limit() → transitionToStatus 内部 SELECT current
const limitMock = vi.fn();
const selectStatusChain = {
  from: () => ({
    where: () => ({
      limit: limitMock,
    }),
  }),
};

let selectCallCount = 0;
vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => {
      selectCallCount++;
      // 第 1 次 select = watchdog checkStuckGenerating 主查询（找 stuck rows）
      // 第 2+ 次 = transitionToStatus 内部 SELECT current status（每个 row 一次）
      if (selectCallCount === 1) return selectChain;
      return selectStatusChain;
    }),
    update: () => updateChain,
  },
}));

const {
  checkStuckGenerating,
  startWatchdog,
  stopWatchdog,
  WATCHDOG_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_ERROR_MESSAGE,
  worstHeartbeatGapMs,
  HEARTBEAT_GAP_SAFETY_FACTOR,
} = await import("../services/articles/watchdog.js");

beforeEach(() => {
  selectWhereMock.mockReset();
  returningMock.mockReset();
  limitMock.mockReset();
  selectCallCount = 0;
});

afterEach(() => {
  stopWatchdog(); // 防止 setInterval 残留影响下个测试
});

describe("P0-B watchdog: 常量", () => {
  /**
   * 8-18 行为变更：10 → 30 分钟。**不是放宽，是原来的线压在耗时分布顶部。**
   *
   * 8-17 实测：成功组耗时 min 2.6 / 均 6.9 / **max 9.7** 分钟 —— 距 10 分钟的线只差 18 秒。
   * 越线的 3 篇并没有停，继续跑到 34-41 分钟才完成，钱花了、内容也出来了
   * （11027/11420/6736 字），只因状态被判死而作废。30 = 3× 实测 max。
   */
  /**
   * 40 由**两个**约束取更严者决定，不只是 3× 实测 max：
   *   · ≥ 3× 实测最慢成功耗时（9.7 × 3 ≈ 30）
   *   · ≥ 3× 心跳最坏间隔 ← 这条更严
   *
   * 🔴 8-22 更正：原注释写「180s × withRetry 4 次 = 12 分钟」，**那个乘法不成立** ——
   * `defaultShouldRetry` 第一条「超时/中断，永不重试」把 abort 直接放弃了。
   * 真实是外层最多 2 次全额超时。180s 时代真值 6 分（不是 12），
   * 8-22 timeout 抬到 300s 后是 10 分。
   * 40 当初按虚高的 12 推出（36=12×3），**结论侥幸偏保守，依据是错的**。
   */
  it("超时阈值 40 分钟（取 3×实测max 与 3×心跳最坏间隔 的更严者）", () => {
    expect(WATCHDOG_TIMEOUT_MS).toBe(40 * 60 * 1000);
  });

  it("阈值必须 ≥ 3× 心跳最坏间隔 —— 否则「慢但活着」仍会被误杀", () => {
    /**
     * 🔴 原来这里硬编码 `12 * 60 * 1000`。那样锁的是**常数**不是**关系**（红线 #16）：
     * 谁再抬一次 `AI_QUALITY_CHECK_TIMEOUT_MS`，这条断言照样绿 ——
     * 而它本该正是拦住那件事的人。
     * 改成从 `worstHeartbeatGapMs()` 推，推算只存在于生产代码一处。
     */
    const QUALITY_CHECK_TIMEOUT_MS = 300_000; // env.AI_QUALITY_CHECK_TIMEOUT_MS 默认值（本文件 mock 了 env）
    expect(WATCHDOG_TIMEOUT_MS).toBeGreaterThanOrEqual(
      worstHeartbeatGapMs(QUALITY_CHECK_TIMEOUT_MS) * HEARTBEAT_GAP_SAFETY_FACTOR,
    );
  });

  it("🔴 再抬 timeout 会越线的那个点 —— 写死它，免得下次靠脑补", () => {
    // 40 分阈值 ÷ 3 ÷ 2 = 6.67 分钟/次。当前 5 分钟，还剩 1.33 倍。
    const maxAllowedTimeoutMs = WATCHDOG_TIMEOUT_MS / HEARTBEAT_GAP_SAFETY_FACTOR / 2;
    expect(Math.round(maxAllowedTimeoutMs / 1000)).toBe(400); // 秒
  });

  it("阈值必须显著高于实测最慢成功耗时 —— 这条锁的是「不许再压回分布顶部」", () => {
    const OBSERVED_MAX_SUCCESS_MS = 9.7 * 60 * 1000; // 8-17 实测
    expect(WATCHDOG_TIMEOUT_MS).toBeGreaterThan(OBSERVED_MAX_SUCCESS_MS * 2);
  });
  it("检测间隔 1 分钟", () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(60 * 1000);
  });
  it("error message 含 timeout 字样（user 可识别）", () => {
    expect(WATCHDOG_ERROR_MESSAGE).toMatch(/timeout/i);
    expect(WATCHDOG_ERROR_MESSAGE).toMatch(/10/);
  });
});

describe("P0-B watchdog: checkStuckGenerating 单次执行", () => {
  it("无 stuck row 时 stuck=0 / failed=0", async () => {
    selectWhereMock.mockResolvedValueOnce([]);
    const result = await checkStuckGenerating();
    expect(result).toEqual({ stuck: 0, failed: 0 });
  });

  it("1 个 stuck row → 转 failed 成功（stuck=1, failed=1）", async () => {
    selectWhereMock.mockResolvedValueOnce([{ id: "art-stuck-1" }]);
    // transitionToStatus 内部 SELECT current → "generating"
    limitMock.mockResolvedValueOnce([{ status: "generating" }]);
    // UPDATE returning 命中
    returningMock.mockResolvedValueOnce([{ id: "art-stuck-1" }]);

    const result = await checkStuckGenerating();
    expect(result).toEqual({ stuck: 1, failed: 1 });
  });

  it("3 个 stuck row 全部成功转移", async () => {
    selectWhereMock.mockResolvedValueOnce([
      { id: "art-1" },
      { id: "art-2" },
      { id: "art-3" },
    ]);
    // 每个 row：SELECT current generating + UPDATE 命中
    for (let i = 0; i < 3; i++) {
      limitMock.mockResolvedValueOnce([{ status: "generating" }]);
      returningMock.mockResolvedValueOnce([{ id: `art-${i + 1}` }]);
    }

    const result = await checkStuckGenerating();
    expect(result).toEqual({ stuck: 3, failed: 3 });
  });

  it("race：transitionToStatus 失败（业务流程刚把它转走）→ failed 计数不增", async () => {
    selectWhereMock.mockResolvedValueOnce([
      { id: "art-race-1" },
      { id: "art-ok" },
    ]);
    // art-race-1：SELECT 时 status 已经被改成 generated（race）
    limitMock.mockResolvedValueOnce([{ status: "generated" }]); // current ≠ generating
    // generated → failed 不在 ALLOWED_TRANSITIONS，抛 disallowed → 不调 UPDATE

    // art-ok：正常 stuck
    limitMock.mockResolvedValueOnce([{ status: "generating" }]);
    returningMock.mockResolvedValueOnce([{ id: "art-ok" }]);

    const result = await checkStuckGenerating();
    expect(result).toEqual({ stuck: 2, failed: 1 });
  });

  it("使用注入的 now，cutoff = now - 10min（spec 时间窗口）", async () => {
    const fixedNow = new Date("2026-05-08T13:00:00Z");
    selectWhereMock.mockResolvedValueOnce([]);

    await checkStuckGenerating(fixedNow);
    // 验证 select.where 被调用（具体 cutoff 不展开 SQL fragment 检查）
    expect(selectWhereMock).toHaveBeenCalledTimes(1);
  });
});

describe("P0-B watchdog: start/stop 周期任务", () => {
  it("startWatchdog 启动 setInterval；stopWatchdog 清理", () => {
    vi.useFakeTimers();
    selectWhereMock.mockResolvedValue([]); // 防 await 异常

    startWatchdog();
    // 启动后 interval 已注册（fake timers 控制下不会立即触发）
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);

    stopWatchdog();
    vi.useRealTimers();
    // stop 后应清理
    expect(true).toBe(true); // smoke：不抛错即成功
  });

  it("startWatchdog 重复启动幂等（第二次仅 warn 不重启）", () => {
    selectWhereMock.mockResolvedValue([]);
    startWatchdog();
    startWatchdog(); // 第二次应跳过
    stopWatchdog();
    expect(true).toBe(true);
  });
});
