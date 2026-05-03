/** B.5: feature flag 双 AND + 5s 缓存。 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const envState = { SALES_AGENT_ENABLED: true };
vi.mock("../config/env.js", () => ({ env: envState }));

const dbState = { rows: [] as { enabled: boolean }[], queryCount: 0 };
vi.mock("../models/db.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => { dbState.queryCount++; return dbState.rows; } }) }) }) },
}));

const { isSalesAgentEnabled, clearFeatureFlagCache } = await import("../services/feature-flags.js");

const TENANT = "11111111-2222-3333-4444-555555555555";

beforeEach(() => { dbState.rows = []; dbState.queryCount = 0; envState.SALES_AGENT_ENABLED = true; clearFeatureFlagCache(); });

describe("isSalesAgentEnabled 双 AND + 缓存", () => {
  it("env=false → 直接 false 不打 DB（总闸优先）", async () => {
    envState.SALES_AGENT_ENABLED = false;
    dbState.rows = [{ enabled: true }];
    expect(await isSalesAgentEnabled(TENANT)).toBe(false);
    expect(dbState.queryCount).toBe(0);
  });
  it("env=true && 表无记录 → false（白名单制默认关）", async () => {
    expect(await isSalesAgentEnabled(TENANT)).toBe(false);
  });
  it("env=true && tenant flag enabled=true → true", async () => {
    dbState.rows = [{ enabled: true }];
    expect(await isSalesAgentEnabled(TENANT)).toBe(true);
  });
  it("env=true && tenant flag enabled=false → false", async () => {
    dbState.rows = [{ enabled: false }];
    expect(await isSalesAgentEnabled(TENANT)).toBe(false);
  });
  it("5s 缓存：连续 3 次只打 1 次 DB", async () => {
    dbState.rows = [{ enabled: true }];
    await isSalesAgentEnabled(TENANT);
    await isSalesAgentEnabled(TENANT);
    await isSalesAgentEnabled(TENANT);
    expect(dbState.queryCount).toBe(1);
  });
  it("clearFeatureFlagCache → 强制 refetch", async () => {
    dbState.rows = [{ enabled: true }];
    await isSalesAgentEnabled(TENANT);
    expect(dbState.queryCount).toBe(1);
    clearFeatureFlagCache();
    await isSalesAgentEnabled(TENANT);
    expect(dbState.queryCount).toBe(2);
  });
});
