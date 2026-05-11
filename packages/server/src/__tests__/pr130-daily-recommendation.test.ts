/**
 * PR #130 V2.5 daily-recommendation 静态校验（5-13）。
 * 防回归: scheduler 注册 + handler case + system tenant constants + content 端点 ?recommendation 支持.
 */
import { describe, it, expect } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(48), LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", DATABASE_URL: "postgres://t/t" },
}));

import { vi } from "vitest";

describe("PR #130 system tenant sentinel constants", () => {
  it("固定 UUID 常量可 import + 固定值", async () => {
    const m = await import("../config/system-recommendation.js");
    expect(m.SYSTEM_RECOMMENDATION_TENANT_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(m.SYSTEM_RECOMMENDATION_USER_ID).toBe("00000000-0000-0000-0000-000000000002");
  });
});

describe("PR #130 scheduler 接入", () => {
  it("scheduler.ts 含 daily-recommendation type + cron + case handler", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/scheduler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"daily-recommendation"/);
    expect(src).toMatch(/case "daily-recommendation"/);
    expect(src).toMatch(/runDailyRecommendation/);
    expect(src).toMatch(/"daily-recommendation-schedule"/);
    expect(src).toMatch(/pattern: "0 3 \* \* \*"/);
  });
});

describe("PR #130 daily-cron service 静态校验", () => {
  it("含 runDailyRecommendation + 复用 recommendJournals + createBatch + system constants", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/daily-cron.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export async function runDailyRecommendation/);
    expect(src).toMatch(/recommendJournals/);
    expect(src).toMatch(/createBatch/);
    expect(src).toMatch(/SYSTEM_RECOMMENDATION_TENANT_ID/);
    expect(src).toMatch(/SYSTEM_RECOMMENDATION_USER_ID/);
    // 守 batch size + fresh 阈值，防意外改坏
    expect(src).toMatch(/RECOMMENDATION_BATCH_SIZE\s*=\s*10/);
    expect(src).toMatch(/FRESH_APPEAR_COUNT_MAX\s*=\s*7/);
  });
});

describe("PR #130 content route ?recommendation=true 支持", () => {
  it("routes/content.ts GET / 含 recommendation query → switch tenant", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/content.ts", import.meta.url), "utf8");
    expect(src).toMatch(/recommendation\?:\s*string/);
    expect(src).toMatch(/SYSTEM_RECOMMENDATION_TENANT_ID/);
    expect(src).toMatch(/query\.recommendation === "true"/);
  });
});

describe("PR #130 migrate.ts system tenant + user idempotent INSERT", () => {
  it("含 ON CONFLICT DO NOTHING for system tenant + user", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/migrate.ts", import.meta.url), "utf8");
    expect(src).toMatch(/INSERT INTO tenants[\s\S]*00000000-0000-0000-0000-000000000001[\s\S]*ON CONFLICT \(id\) DO NOTHING/);
    expect(src).toMatch(/INSERT INTO users[\s\S]*00000000-0000-0000-0000-000000000002[\s\S]*ON CONFLICT \(id\) DO NOTHING/);
  });
});
