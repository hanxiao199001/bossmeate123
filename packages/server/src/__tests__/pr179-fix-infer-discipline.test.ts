/**
 * PR #179 — inferDiscipline 修 + topics 支持
 */
import { describe, it, expect, vi } from "vitest";

// Mock env to avoid DB init
vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(48), LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", DATABASE_URL: "postgres://t/t" },
}));

import { inferDiscipline, type OpenAlexSource } from "../scripts/expand-journals-pool.js";

const mockSource = (topics: Array<{ field?: string; domain?: string }>, concepts: Array<{ name: string; level: number; score: number }> = []): OpenAlexSource => ({
  id: "test",
  display_name: "Test Journal",
  issn_l: "0000-0000",
  issn: ["0000-0000"],
  type: "journal",
  cited_by_count: 1000,
  works_count: 100,
  homepage_url: null,
  x_concepts: concepts.map(c => ({ display_name: c.name, level: c.level, score: c.score })),
  topics: topics.map(t => ({
    display_name: "topic",
    field: t.field ? { display_name: t.field } : undefined,
    domain: t.domain ? { display_name: t.domain } : undefined,
  })),
});

describe("PR #179: inferDiscipline 从 topics 推断", () => {
  it("topics field=Medicine → medicine", () => {
    expect(inferDiscipline(mockSource([{ field: "Medicine" }]))).toBe("medicine");
  });

  it("topics domain=Health Sciences → medicine", () => {
    expect(inferDiscipline(mockSource([{ domain: "Health Sciences" }]))).toBe("medicine");
  });

  it("topics field=Psychology → psychology", () => {
    expect(inferDiscipline(mockSource([{ field: "Psychology" }]))).toBe("psychology");
  });

  it("topics field=Computer Science → computer", () => {
    expect(inferDiscipline(mockSource([{ field: "Computer Science" }]))).toBe("computer");
  });

  it("topics field=Economics → economics", () => {
    expect(inferDiscipline(mockSource([{ field: "Economics and Econometrics" }]))).toBe("economics");
  });

  it("topics field=Engineering → engineering", () => {
    expect(inferDiscipline(mockSource([{ field: "Engineering" }]))).toBe("engineering");
  });

  it("topics field=Agricultural → agriculture", () => {
    expect(inferDiscipline(mockSource([{ field: "Plant Science" }]))).toBe("agriculture");
  });

  it("topics field=Environmental Science → environment", () => {
    expect(inferDiscipline(mockSource([{ field: "Environmental Science" }]))).toBe("environment");
  });

  it("topics field=Education → education", () => {
    expect(inferDiscipline(mockSource([{ field: "Education" }]))).toBe("education");
  });

  it("空 topics fallback x_concepts", () => {
    expect(inferDiscipline(mockSource([], [{ name: "Biology", level: 0, score: 0.8 }]))).toBe("biology");
  });

  it("空 topics + 空 concepts → multidisciplinary", () => {
    expect(inferDiscipline(mockSource([]))).toBe("multidisciplinary");
  });
});

describe("PR #179: backfill-discipline script 存在", () => {
  it("含 lookupOpenAlexByIssn + inferDiscipline + UPDATE", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../scripts/backfill-discipline.ts", import.meta.url), "utf8");
    expect(src).toContain("lookupOpenAlexByIssn");
    expect(src).toContain("inferDiscipline");
    expect(src).toContain("UPDATE");
    expect(src).toContain("discipline");
  });
});
