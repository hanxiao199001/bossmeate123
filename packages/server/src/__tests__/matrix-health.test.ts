/**
 * 7-10 矩阵总览 — 账号健康判定纯函数单测。
 * matrix-health.ts 无任何 IO/env 依赖，可直接 import（无需 mock db/env）。
 */
import { describe, it, expect } from "vitest";
import {
  computeAccountHealth,
  startOfBjDay,
  idleWindowStart,
  healthRank,
  type HealthInput,
} from "../services/metrics/matrix-health.js";

const DAY = 86_400_000;

/** 固定"现在" = 北京时间 2026-07-10 15:00 (UTC 07:00) */
const NOW = new Date("2026-07-10T07:00:00.000Z");
const TODAY = startOfBjDay(NOW); // = 2026-07-09T16:00:00Z (BJ 7-10 00:00)

function base(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    accountStatus: "active",
    loginStatus: "logged_in",
    agentDeviceBound: false,
    agentOnline: false,
    loginExpired24h: false,
    lastSuccessAt: new Date(NOW.getTime() - 3600_000), // 1h 前刚成功发过
    assignedToday: 2,
    createdAt: new Date(NOW.getTime() - 30 * DAY),
    ...overrides,
  };
}

describe("startOfBjDay / idleWindowStart", () => {
  it("BJ 零点按 UTC+8 切: UTC 07:00 属于 BJ 当天, 起点应是前一天 UTC 16:00", () => {
    expect(TODAY.toISOString()).toBe("2026-07-09T16:00:00.000Z");
  });

  it("UTC 17:00 (BJ 次日 01:00) 应切到 BJ 次日零点", () => {
    const t = startOfBjDay(new Date("2026-07-09T17:00:00.000Z"));
    expect(t.toISOString()).toBe("2026-07-09T16:00:00.000Z");
  });

  it("UTC 15:00 (BJ 当日 23:00) 仍是 BJ 当天", () => {
    const t = startOfBjDay(new Date("2026-07-09T15:00:00.000Z"));
    expect(t.toISOString()).toBe("2026-07-08T16:00:00.000Z");
  });

  it("idle 窗口起点 = 今天零点往前推 2 天 (覆盖前天/昨天/今天三个自然日)", () => {
    expect(idleWindowStart(TODAY).getTime()).toBe(TODAY.getTime() - 2 * DAY);
  });
});

describe("computeAccountHealth — 单项判定", () => {
  it("一切正常 → healthy, flags 空", () => {
    const r = computeAccountHealth(base(), TODAY);
    expect(r.health).toBe("healthy");
    expect(r.flags).toEqual([]);
  });

  it("disabled 账号 → disabled, 不出任何告警", () => {
    const r = computeAccountHealth(
      base({ accountStatus: "disabled", assignedToday: 0, lastSuccessAt: null }),
      TODAY,
    );
    expect(r.health).toBe("disabled");
    expect(r.flags).toEqual([]);
  });

  it("近 24h agent 任务 login_expired → login_expired", () => {
    const r = computeAccountHealth(base({ loginExpired24h: true }), TODAY);
    expect(r.health).toBe("login_expired");
  });

  it("loginStatus=expired (保活巡检/任务回报置的) → login_expired", () => {
    const r = computeAccountHealth(base({ loginStatus: "expired" }), TODAY);
    expect(r.health).toBe("login_expired");
  });

  it("accountStatus=expired (verify 失败痕迹) → token_invalid", () => {
    const r = computeAccountHealth(base({ accountStatus: "expired" }), TODAY);
    expect(r.health).toBe("token_invalid");
  });

  it("绑定设备且离线 → agent_offline; 未绑定设备不判", () => {
    const offline = computeAccountHealth(base({ agentDeviceBound: true, agentOnline: false }), TODAY);
    expect(offline.health).toBe("agent_offline");

    const unbound = computeAccountHealth(base({ agentDeviceBound: false, agentOnline: false }), TODAY);
    expect(unbound.health).toBe("healthy");

    const online = computeAccountHealth(base({ agentDeviceBound: true, agentOnline: true }), TODAY);
    expect(online.health).toBe("healthy");
  });

  it("今天没分到内容 → no_content_today", () => {
    const r = computeAccountHealth(base({ assignedToday: 0 }), TODAY);
    expect(r.health).toBe("no_content_today");
  });
});

describe("computeAccountHealth — idle_3d 边界", () => {
  const idleSince = idleWindowStart(TODAY); // 前天 BJ 00:00

  it("最近成功发布正好在窗口起点 (前天 00:00 整) → 不算 idle", () => {
    const r = computeAccountHealth(base({ lastSuccessAt: new Date(idleSince.getTime()) }), TODAY);
    expect(r.flags).not.toContain("idle_3d");
  });

  it("最近成功发布在窗口起点前 1ms → idle_3d", () => {
    const r = computeAccountHealth(base({ lastSuccessAt: new Date(idleSince.getTime() - 1) }), TODAY);
    expect(r.flags).toContain("idle_3d");
  });

  it("昨天发过 → 不算 idle", () => {
    const r = computeAccountHealth(base({ lastSuccessAt: new Date(TODAY.getTime() - DAY / 2) }), TODAY);
    expect(r.flags).not.toContain("idle_3d");
  });

  it("从未成功发布 + 老账号 (创建 > 3 天) → idle_3d", () => {
    const r = computeAccountHealth(
      base({ lastSuccessAt: null, createdAt: new Date(NOW.getTime() - 30 * DAY) }),
      TODAY,
    );
    expect(r.flags).toContain("idle_3d");
  });

  it("从未成功发布但账号是昨天刚建的 → 宽限, 不判 idle", () => {
    const r = computeAccountHealth(
      base({ lastSuccessAt: null, createdAt: new Date(NOW.getTime() - DAY) }),
      TODAY,
    );
    expect(r.flags).not.toContain("idle_3d");
  });
});

describe("computeAccountHealth — 多告警优先级", () => {
  it("login_expired > agent_offline > idle_3d > no_content_today, flags 按严重度排序", () => {
    const r = computeAccountHealth(
      base({
        loginExpired24h: true,
        agentDeviceBound: true,
        agentOnline: false,
        lastSuccessAt: null,
        assignedToday: 0,
      }),
      TODAY,
    );
    expect(r.health).toBe("login_expired");
    expect(r.flags).toEqual(["login_expired", "agent_offline", "idle_3d", "no_content_today"]);
  });

  it("token_invalid 严重度高于 agent_offline", () => {
    const r = computeAccountHealth(
      base({ accountStatus: "expired", agentDeviceBound: true, agentOnline: false }),
      TODAY,
    );
    expect(r.health).toBe("token_invalid");
  });

  it("healthRank 排序: 异常都排在 healthy 前, disabled 最后", () => {
    expect(healthRank("login_expired")).toBeLessThan(healthRank("healthy"));
    expect(healthRank("no_content_today")).toBeLessThan(healthRank("healthy"));
    expect(healthRank("healthy")).toBeLessThan(healthRank("disabled"));
  });
});
