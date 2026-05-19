/**
 * PR #176 — expand-journals-pool 静态校验
 */
import { describe, it, expect } from "vitest";

describe("PR #176: expand-journals-pool script", () => {
  it("含 OpenAlex fetch + dedup + insert + enrich + 报告", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../scripts/expand-journals-pool.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/api\.openalex\.org\/sources/);
    expect(src).toMatch(/fetchOpenAlexSources/);
    expect(src).toMatch(/existingIssns/);
    expect(src).toMatch(/onConflictDoNothing/);
    expect(src).toMatch(/enrichJournal/);
    expect(src).toMatch(/THROTTLE_MS/);
    expect(src).toMatch(/openalex_ingest/);
    expect(src).toMatch(/confidence:\s*60/);
  });

  it("inferDiscipline 覆盖 12 学科 mapping", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../scripts/expand-journals-pool.ts", import.meta.url),
      "utf8",
    );
    for (const d of ["medicine", "biology", "psychology", "education", "economics", "engineering", "computer", "agriculture", "environment", "law", "chemistry", "physics"]) {
      expect(src).toContain(`"${d}"`);
    }
  });

  it("支持 --count=N 参数", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../scripts/expand-journals-pool.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/--count=/);
  });
});
