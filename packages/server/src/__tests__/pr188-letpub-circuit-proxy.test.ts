/**
 * 5-20 PR #188 — LetPub 封 IP 应对: 全局熔断开关 + 代理支持. file-content regression.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #188: ENRICH_SKIP_LETPUB 全局熔断", () => {
  it("orchestrator: env 开关全局跳过 LetPub", async () => {
    const src = await readSrc("../services/journal-enricher/orchestrator.ts");
    expect(src).toMatch(/process\.env\.ENRICH_SKIP_LETPUB === "true"/);
    expect(src).toMatch(/const skipLetpub = options\?\.skipLetpub \|\| process\.env\.ENRICH_SKIP_LETPUB/);
    // letpub fetch 用 skipLetpub 守卫 (不再直接 options?.skipLetpub)
    expect(src).toMatch(/timed\("letpub", skipLetpub \?/);
  });
});

describe("PR #188: 代理支持", () => {
  it("journal_scraper.py: --proxy CLI + session 透传", async () => {
    const src = await readSrc("../../scripts/journal_scraper.py");
    expect(src).toMatch(/--proxy/);
    expect(src).toMatch(/proxy_kwargs/);
  });
  it("scrapling-bridge: crawlLetpubCategory 透传 proxy", async () => {
    const src = await readSrc("../services/crawler/scrapling-bridge.ts");
    expect(src).toMatch(/proxy\?: string/);
    expect(src).toMatch(/args\.push\("--proxy", opts\.proxy\)/);
  });
  it("ingest-letpub-pool: 读 env LETPUB_PROXY", async () => {
    const src = await readSrc("../scripts/ingest-letpub-pool.ts");
    expect(src).toMatch(/process\.env\.LETPUB_PROXY/);
  });
});
