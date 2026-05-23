/**
 * 5-22 PR #216 — jcarindex 抓 CAR 时顺手回填残留官网(linkOfficialWebsite).
 * 摸清: jcarindex 无新锐分区(只 partCas/partJcr 标准分区); 但有 linkOfficialWebsite → 补 ③ 残留官网.
 * 仅当 DB website 为 NULL 才填, 不覆盖真值, 排除 Springer 登录页, provenance=jcarindex.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-jcar-car.ts";

describe("PR #216: jcarindex 顺手回填官网", () => {
  it("JcarRecord 取 linkOfficialWebsite", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/linkOfficialWebsite\?: string \| null;/);
  });
  it("targets 查出 website (判 NULL)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/\.select\(\{ id: journals\.id, name: journals\.name, issn: journals\.issn, website: journals\.website \}\)/);
  });
  it("仅 NULL 才填 + 合法 http + 排除 Springer 登录页 + provenance", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/if \(!j\.website && \/\^https\?:\\\/\\\/\/i\.test\(site\) && !\/idp\\\.springer\\\.com\/i\.test\(site\)\)/);
    expect(src).toMatch(/"website":"jcarindex"/);
  });
  it("siteFilled 计数 + 报告", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/siteFilled \+= 1/);
    expect(src).toMatch(/顺手补官网/);
  });
});
