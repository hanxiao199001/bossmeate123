/**
 * PR #190 — enrich orchestrator 存 LetPub 封面 coverImageUrl
 */
import { describe, it, expect } from "vitest";

describe("PR #190: orchestrator 存 LetPub coverImageUrl", () => {
  it("orchestrator.ts 含 coverImageUrl 提取 + provenance 标记", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/journal-enricher/orchestrator.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("coverImageUrl");
    expect(src).toMatch(/tryExtract.*coverImageUrl/);
    expect(src).toMatch(/realProvenance\.coverImageUrl.*letpub/);
  });
});
