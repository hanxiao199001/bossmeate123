/** task #57: migrate.ts parseMigrateArgs unit tests. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { DATABASE_URL: "postgres://test", JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000" },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
// 防 migrate.ts 顶层 migrate() 副作用：mock pg 让它不真连
vi.mock("pg", () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [] }),
      end: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

const { parseMigrateArgs } = await import("../models/migrate.js");

describe("parseMigrateArgs", () => {
  it("returns dryRun=false for empty argv", () => {
    expect(parseMigrateArgs([])).toEqual({ dryRun: false });
  });
  it("returns dryRun=true when --dry-run present", () => {
    expect(parseMigrateArgs(["--dry-run"])).toEqual({ dryRun: true });
  });
  it("works with --dry-run alongside other flags", () => {
    expect(parseMigrateArgs(["--verbose", "--dry-run", "--foo"])).toEqual({ dryRun: true });
  });
  it("ignores unknown / partial flags (no false positive)", () => {
    expect(parseMigrateArgs(["--verbose"])).toEqual({ dryRun: false });
    expect(parseMigrateArgs(["dry-run"])).toEqual({ dryRun: false });
    expect(parseMigrateArgs(["--dry"])).toEqual({ dryRun: false });
  });
});
