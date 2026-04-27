import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock env (avoids env.ts:148 process.exit(1) in collect phase)
vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    CREDENTIALS_KEY: "test-credentials-key",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock drizzle db chain — set per-test return values via the inner stubs
const returningStub = vi.fn();
const limitStub = vi.fn();

vi.mock("../models/db.js", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: returningStub,
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: limitStub,
        }),
      }),
    }),
  },
}));

vi.mock("../models/schema.js", () => ({
  journals: {
    id: "id-col",
    coverImageUrl: "cover-col",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => "eq-stub",
  and: () => "and-stub",
  isNull: () => "isnull-stub",
}));

// Import the function AFTER mocks are set up
const { persistJournalCover } = await import("../services/crawler/journal-cover-persist.js");

describe("persistJournalCover", () => {
  beforeEach(() => {
    returningStub.mockReset();
    limitStub.mockReset();
  });

  it("returns updated=true when cover_image_url was NULL and update affected 1 row", async () => {
    returningStub.mockResolvedValueOnce([{ id: "j-1" }]);

    const result = await persistJournalCover("j-1", "https://cdn/cover.jpg", "inline-skill");

    expect(result).toEqual({ updated: true });
    expect(returningStub).toHaveBeenCalledTimes(1);
    expect(limitStub).not.toHaveBeenCalled();
  });

  it("returns updated=false reason=already_has_cover when WHERE filtered out a row that exists", async () => {
    returningStub.mockResolvedValueOnce([]);
    limitStub.mockResolvedValueOnce([{ id: "j-1" }]);

    const result = await persistJournalCover("j-1", "https://cdn/cover.jpg", "inline-skill");

    expect(result).toEqual({ updated: false, reason: "already_has_cover" });
  });

  it("returns updated=false reason=journal_not_found when journalId does not exist", async () => {
    returningStub.mockResolvedValueOnce([]);
    limitStub.mockResolvedValueOnce([]);

    const result = await persistJournalCover("missing-id", "https://cdn/cover.jpg", "inline-skill");

    expect(result).toEqual({ updated: false, reason: "journal_not_found" });
  });

  it("returns updated=false reason=journal_not_found for empty journalId without hitting db", async () => {
    const result = await persistJournalCover("", "https://cdn/cover.jpg", "inline-skill");

    expect(result).toEqual({ updated: false, reason: "journal_not_found" });
    expect(returningStub).not.toHaveBeenCalled();
  });

  it("never throws — catches db errors and returns reason='error: ...'", async () => {
    returningStub.mockRejectedValueOnce(new Error("connection refused"));

    const result = await persistJournalCover("j-1", "https://cdn/cover.jpg", "inline-skill");

    expect(result.updated).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^error: connection refused/);
  });
});
