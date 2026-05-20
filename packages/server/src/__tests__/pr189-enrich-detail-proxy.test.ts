/**
 * PR #189 — LetPub 详情爬代理支持 (LETPUB_PROXY env + undici ProxyAgent)
 */
import { describe, it, expect } from "vitest";

describe("PR #189: letpub-detail-scraper 代理支持", () => {
  it("含 ProxyAgent import + LETPUB_PROXY env + dispatcher 注入", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/crawler/letpub-detail-scraper.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/import.*ProxyAgent.*from.*undici/);
    expect(src).toMatch(/process\.env\.LETPUB_PROXY/);
    expect(src).toMatch(/new ProxyAgent/);
    expect(src).toMatch(/proxyDispatcher/);
    expect(src).toMatch(/dispatcher.*proxyDispatcher/);
  });

  it("无 LETPUB_PROXY 时 dispatcher = undefined", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/crawler/letpub-detail-scraper.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/LETPUB_PROXY \? new ProxyAgent.*: undefined/);
  });

  it("undici 在 package.json dependencies", async () => {
    const fs = await import("node:fs/promises");
    const pkg = JSON.parse(await fs.readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    ));
    expect(pkg.dependencies?.undici || pkg.devDependencies?.undici).toBeTruthy();
  });
});
