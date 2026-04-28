/** orchestrator B.2.1.A.3: drizzle camelCase + nameEn fallback */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "x", LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "x", DATABASE_URL: "postgres://x" },
}));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("../models/db.js", () => ({ db: {} }));

const { selectQueryName } = await import("../services/journal-enricher/orchestrator.js");
const { journals } = await import("../models/schema.js");

describe("orchestrator B.2.1.A.3 fixes", () => {
  it("Bug B: selectQueryName prefers nameEn (柳叶刀 → The Lancet)", () => {
    expect(selectQueryName({ name: "柳叶刀", nameEn: "The Lancet" })).toBe("The Lancet");
  });
  it("Bug B: selectQueryName falls back to name when nameEn is null", () => {
    expect(selectQueryName({ name: "纯中文期刊", nameEn: null })).toBe("纯中文期刊");
  });
  it("Bug A: Partial<journals.$inferInsert> rejects snake_case at TS compile time", () => {
    type U = Partial<typeof journals.$inferInsert>;
    const valid: U = { ifHistory: { data: [], lastUpdatedAt: "2026-04-28" } };
    // @ts-expect-error - drizzle silently drops snake_case at runtime; type catches it
    const invalid: U = { if_history: { data: [], lastUpdatedAt: "2026-04-28" } };
    expect(valid).toBeDefined();
    expect(invalid).toBeDefined();
  });
});
