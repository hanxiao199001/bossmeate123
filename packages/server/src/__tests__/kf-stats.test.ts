/**
 * kf 概览统计（getKfStats）单测 —— mock db（同 kf-multiturn-memory 的 drizzle 链式 thenable 模式）。
 *
 * 锁定行为：
 *   1. daily 按天补零到 days 条（旧→新、日期连续），today 从 daily 里按上海时区今天取
 *   2. period 总量直通（去重客户数跨天 distinct，不由 daily 求和）
 *   3. unanswered 清单直通（含 question 原文 + conversationId 可跳转）
 *   4. agentSecretConfigured 只回布尔（有 enc=true / 无 enc 或无配置行=false），不回 Secret
 *   5. days 参数钳制 1..30
 *   6. 空库全零不抛
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const selectQueue: Array<Row[] | Error> = [];

  // drizzle 链式 thenable：任意链式调用返回自身，await 时按队列出结果
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
  db: { select: () => h.chain(h.selectQueue.shift() ?? []) },
}));

const { getKfStats } = await import("../services/work-wechat/kf-stats.js");

const TENANT = "t-1";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const todayStr = dayFmt.format(new Date());
/** 上海时区 today 往前 n 天的 YYYY-MM-DD */
function daysAgo(n: number): string {
  const base = new Date(`${todayStr}T00:00:00+08:00`);
  return dayFmt.format(new Date(base.getTime() - n * 86_400_000));
}

const bucket = (over: Record<string, number> = {}) => ({
  conversations: 0, customerMessages: 0, aiReplies: 0, handoffs: 0, manualReplies: 0, ...over,
});

// getKfStats 内 db.select 调用顺序：① period 总量 ② daily 序列 ③ unanswered ④ config
function queue(opts: {
  period?: Record<string, unknown>;
  daily?: Array<Record<string, unknown>>;
  unanswered?: Array<Record<string, unknown>>;
  config?: Array<Record<string, unknown>>;
}) {
  h.selectQueue.push(
    opts.period ? [opts.period] : [],
    opts.daily ?? [],
    opts.unanswered ?? [],
    opts.config ?? [],
  );
}

beforeEach(() => { h.selectQueue.length = 0; });

describe("getKfStats", () => {
  it("daily 补零到 7 天、日期旧→新连续；today 取上海时区今天那格", async () => {
    queue({
      period: bucket({ conversations: 3, customerMessages: 20, aiReplies: 15, handoffs: 4, manualReplies: 6 }),
      daily: [
        { date: daysAgo(3), ...bucket({ conversations: 2, customerMessages: 8, aiReplies: 6, handoffs: 1, manualReplies: 2 }) },
        { date: todayStr, ...bucket({ conversations: 1, customerMessages: 12, aiReplies: 9, handoffs: 3, manualReplies: 4 }) },
      ],
      config: [{ agentSecretEnc: null }],
    });

    const res = await getKfStats(TENANT, 7);

    expect(res.days).toBe(7);
    expect(res.daily).toHaveLength(7);
    // 日期连续：第 i 格 = 6-i 天前
    for (let i = 0; i < 7; i++) expect(res.daily[i].date).toBe(daysAgo(6 - i));
    // 有数据的天直通，其余全零
    expect(res.daily[3]).toEqual({ date: daysAgo(3), ...bucket({ conversations: 2, customerMessages: 8, aiReplies: 6, handoffs: 1, manualReplies: 2 }) });
    expect(res.daily[0]).toEqual({ date: daysAgo(6), ...bucket() });
    // today = daily 最后一格（上海时区今天）
    expect(res.today.date).toBe(todayStr);
    expect(res.today.handoffs).toBe(3);
    expect(res.today.aiReplies).toBe(9);
    // period 直通（不是 daily 求和）
    expect(res.period).toEqual(bucket({ conversations: 3, customerMessages: 20, aiReplies: 15, handoffs: 4, manualReplies: 6 }));
    expect(res.agentSecretConfigured).toBe(false);
  });

  it("unanswered 清单直通：客户原话 + conversationId 可跳转", async () => {
    queue({
      period: bucket({ handoffs: 1 }),
      unanswered: [
        { conversationId: "conv-1", externalUserid: "wx-u1", question: "你们加急服务多少钱？", transferredAt: "2026-07-23T02:00:00.000Z" },
        { conversationId: "conv-2", externalUserid: "wx-u2", question: null, transferredAt: "2026-07-22T02:00:00.000Z" },
      ],
      config: [{ agentSecretEnc: "enc-xxx" }],
    });

    const res = await getKfStats(TENANT, 7);
    expect(res.unanswered).toHaveLength(2);
    expect(res.unanswered[0]).toMatchObject({ conversationId: "conv-1", question: "你们加急服务多少钱？" });
    expect(res.unanswered[1].question).toBeNull(); // 非文本消息触发的转人工
    expect(res.agentSecretConfigured).toBe(true);
    // 绝不回 Secret 本身
    expect(JSON.stringify(res)).not.toContain("enc-xxx");
  });

  it("agentSecretEnc 为空/无配置行 → agentSecretConfigured=false", async () => {
    queue({ config: [] });
    const res = await getKfStats(TENANT, 7);
    expect(res.agentSecretConfigured).toBe(false);
  });

  it("days 钳制：999→30、0→默认 7、负数→1", async () => {
    queue({});
    expect((await getKfStats(TENANT, 999)).daily).toHaveLength(30);
    queue({});
    expect((await getKfStats(TENANT, 0)).daily).toHaveLength(7);
    queue({});
    expect((await getKfStats(TENANT, -5)).daily).toHaveLength(1);
  });

  it("空库：全零不抛，unanswered 空数组", async () => {
    queue({});
    const res = await getKfStats(TENANT, 7);
    expect(res.period).toEqual(bucket());
    expect(res.today).toEqual({ date: todayStr, ...bucket() });
    expect(res.daily.every((d) => d.customerMessages === 0)).toBe(true);
    expect(res.unanswered).toEqual([]);
    expect(res.agentSecretConfigured).toBe(false);
  });
});
