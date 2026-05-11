/**
 * PR #133 V2.5 Day 1 (5-12) backend feed 静态校验.
 * 验证 schema / migration / service / route 全在.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(48), LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", DATABASE_URL: "postgres://t/t" },
}));

describe("PR #133 user_skip_log schema + migration", () => {
  it("schema.ts 含 userSkipLog table 定义", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/schema.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export const userSkipLog = pgTable\(\s*"user_skip_log"/);
    expect(src).toMatch(/tenantId: uuid\("tenant_id"\)\.notNull\(\)/);
    expect(src).toMatch(/contentId: uuid\("content_id"\)\.notNull\(\)/);
    expect(src).toMatch(/skippedAt:.*timestamp\("skipped_at"/);
  });

  it("migrate.ts 含 user_skip_log CREATE TABLE + PK", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/migrate.ts", import.meta.url), "utf8");
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS user_skip_log/);
    expect(src).toMatch(/PRIMARY KEY \(tenant_id, content_id\)/);
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_skip_log_tenant/);
  });
});

describe("PR #133 feed-service 静态校验", () => {
  it("export fetchRecommendations + 含 system tenant + LEFT JOIN journals + skip 过滤", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/feed-service.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export async function fetchRecommendations/);
    expect(src).toMatch(/SYSTEM_RECOMMENDATION_TENANT_ID/);
    expect(src).toMatch(/LEFT JOIN journals/);
    expect(src).toMatch(/LEFT JOIN user_skip_log/);
    expect(src).toMatch(/ORDER BY j\.confidence DESC NULLS LAST/);
    expect(src).toMatch(/FRESH_WINDOW_DAYS\s*=\s*7/);
    expect(src).toMatch(/INTERVAL.*FRESH_WINDOW_DAYS/);
  });

  it("默认 limit=10, max 50", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/feed-service.ts", import.meta.url), "utf8");
    expect(src).toMatch(/DEFAULT_LIMIT\s*=\s*10/);
    expect(src).toMatch(/MAX_LIMIT\s*=\s*50/);
  });
});

describe("PR #133 content.ts 端点接入", () => {
  it("含 GET /recommendations + POST /:id/skip endpoints", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/content.ts", import.meta.url), "utf8");
    expect(src).toMatch(/app\.get\("\/recommendations"/);
    expect(src).toMatch(/app\.post\("\/:id\/skip"/);
    expect(src).toMatch(/fetchRecommendations/);
    expect(src).toMatch(/INSERT INTO user_skip_log/);
    expect(src).toMatch(/ON CONFLICT \(tenant_id, content_id\) DO NOTHING/);
  });

  it("skip endpoint 仅允许 system tenant article", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/content.ts", import.meta.url), "utf8");
    // skip 验证 contents.tenantId = SYSTEM (防 user 自己 article 被乱 skip)
    expect(src).toMatch(/eq\(contents\.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID\)/);
  });
});
