/**
 * 8-02 LLM 日配额分片 + 重试判据 —— 2026-08-01 事故的防回归。
 *
 * 事故: 行业月度 cron 在 BJ 00:00 一次性入队 593 行(平时 24), 每篇要 8~10 次 LLM 调用,
 *   日上限 2000 次 → 第一个租户 199 行跑完就把配额烧光, 后两个租户 394 行**永久 failed**。
 *
 * 这里锁三件:
 *   ① 分片: 超出今日剩余配额的行必须被顺延, 而不是全部立即入队
 *   ② 重试判据: 429/5xx 要重试, 超时**绝不**重试(推理模型超时重试=纯烧配额)
 *   ③ 状态码提取: 必须认得本项目 provider 的真实抛错格式(旧正则永远匹配不上)
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {}, testConnection: vi.fn(async () => true) }));
vi.mock("../models/schema.js", () => ({ contents: {}, costLedger: {} }));

const {
  computeTodayCapacity, computeFullDayCapacity, delayToBjMidnight,
  CAPACITY_SAFETY_RATIO, CALLS_PER_ARTICLE_MIN,
} = await import("../services/batch/enqueue-planner.js");
const { defaultShouldRetry, extractStatus, isAbortLike } = await import("../utils/retry.js");

describe("① 日配额分片容量", () => {
  it("用事故当天的真实数字: 2000 次上限 / 9.3 次每篇 → 今天最多约 172 行(不是 593)", () => {
    const cap = computeTodayCapacity(2000, 0, 9.3);
    expect(cap).toBe(Math.floor((2000 * CAPACITY_SAFETY_RATIO) / 9.3)); // 172
    expect(cap).toBeLessThan(593);   // ★ 这就是事故: 593 行远超天花板
  });

  it("已用掉的配额要扣掉 —— 第一个租户跑完后, 后面的租户才是撞顶的那批", () => {
    // 事故序列: 租户A 199 行跑掉约 1850 次调用后, 剩余配额只够很少几行
    const capAfter = computeTodayCapacity(2000, 1850, 9.3);
    expect(capAfter).toBeLessThan(20);
    expect(capAfter).toBeGreaterThanOrEqual(0);
  });

  it("配额用尽 → 容量 0(全部顺延), 绝不返回负数", () => {
    expect(computeTodayCapacity(2000, 5000, 9.3)).toBe(0);
  });

  it("未设日上限(0) → 不分片(容量无限, 保持原行为)", () => {
    expect(computeTodayCapacity(0, 999, 9.3)).toBe(Number.POSITIVE_INFINITY);
  });

  it("每篇调用数异常小也不会把容量算炸(有下界保护)", () => {
    // 若某天统计出 0.1 次/篇, 不加保护会算出 16000 行的容量
    const cap = computeTodayCapacity(2000, 0, 0.1);
    expect(cap).toBe(Math.floor((2000 * CAPACITY_SAFETY_RATIO) / CALLS_PER_ARTICLE_MIN));
  });

  it("整天容量 ≥ 1 —— 否则顺延会算出无限天", () => {
    expect(computeFullDayCapacity(2000, 9.3)).toBeGreaterThan(0);
    expect(computeFullDayCapacity(10, 30)).toBeGreaterThanOrEqual(1);
  });
});

describe("① 顺延延迟落在北京时间零点后", () => {
  it("delay 指向次日 BJ 00:05, 不是零点整(避开与日配额归零抢同一毫秒)", () => {
    // 2026-08-02 07:25 UTC = BJ 15:25
    const now = new Date("2026-08-02T07:25:00Z");
    const d = delayToBjMidnight(1, now);
    const target = new Date(now.getTime() + d);
    // BJ 时间 = UTC+8
    const bj = new Date(target.getTime() + 8 * 3600_000);
    expect(bj.toISOString().slice(0, 10)).toBe("2026-08-03");
    expect(bj.getUTCHours()).toBe(0);
    expect(bj.getUTCMinutes()).toBe(5);
  });

  it("dayOffset 越大延迟越长(顺延多天要能真的分开)", () => {
    const now = new Date("2026-08-02T07:25:00Z");
    expect(delayToBjMidnight(2, now)).toBeGreaterThan(delayToBjMidnight(1, now));
    expect(delayToBjMidnight(3, now)).toBeGreaterThan(delayToBjMidnight(2, now));
  });

  it("延迟绝不为负", () => {
    expect(delayToBjMidnight(0, new Date("2026-08-02T23:59:00Z"))).toBeGreaterThanOrEqual(0);
  });
});

describe("② 重试判据: 429 重试 / 超时不重试", () => {
  it("🔴 超时/中断绝不重试(推理模型超时是自身属性, 重试=纯烧配额)", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(defaultShouldRetry(abort, 1)).toBe(false);
    expect(defaultShouldRetry(new Error("request timed out"), 1)).toBe(false);
    expect(isAbortLike(abort)).toBe(true);
  });

  it("🔴 abort 即使带 5xx 文案也不重试(判断顺序: abort 优先于状态码)", () => {
    const e = new Error("deepseek API 错误: 503 - This operation was aborted");
    expect(defaultShouldRetry(e, 1)).toBe(false);
  });

  it("429 限流要重试", () => {
    expect(defaultShouldRetry(new Error("deepseek API 错误: 429 - rate limit"), 1)).toBe(true);
  });

  it("5xx 要重试", () => {
    expect(defaultShouldRetry(new Error("qwen API 错误: 502 - bad gateway"), 1)).toBe(true);
  });

  it("其余 4xx 不重试(参数错/鉴权错, 重试多少次都一样)", () => {
    expect(defaultShouldRetry(new Error("deepseek API 错误: 401 - unauthorized"), 1)).toBe(false);
    expect(defaultShouldRetry(new Error("deepseek API 错误: 400 - bad request"), 1)).toBe(false);
  });

  it("连接层瞬断要重试(压根没到服务端)", () => {
    expect(defaultShouldRetry(new Error("socket hang up"), 1)).toBe(true);
    const e = new Error("connection reset") as Error & { code?: string };
    e.code = "ECONNRESET";
    expect(defaultShouldRetry(e, 1)).toBe(true);
  });

  it("认不出来的错误不重试(保守: 宁可少重试也别烧配额)", () => {
    expect(defaultShouldRetry(new Error("something odd happened"), 1)).toBe(false);
    expect(defaultShouldRetry("not an error", 1)).toBe(false);
  });
});

describe("③ 状态码提取: 必须认得本项目 provider 的真实格式", () => {
  it("🔴 结构化 status 优先(provider 层已挂, 唯一可靠来源)", () => {
    const e = new Error("whatever") as Error & { status?: number };
    e.status = 429;
    expect(extractStatus(e)).toBe(429);
    expect(defaultShouldRetry(e, 1)).toBe(true);
  });

  it("🔴 认得 `${name} API 错误: 429 - ...` —— 旧正则要的是 `API 429:`(数字在冒号前), 永远匹配不上", () => {
    expect(extractStatus(new Error("deepseek API 错误: 429 - too many requests"))).toBe(429);
    expect(extractStatus(new Error("deepseek API 错误: 500 - oops"))).toBe(500);
  });

  it("向后兼容老格式 `API 429:`", () => {
    expect(extractStatus(new Error("API 429: rate limited"))).toBe(429);
  });

  it("完全没有状态码 → null(而不是瞎猜一个)", () => {
    expect(extractStatus(new Error("connection closed"))).toBeNull();
  });
});
