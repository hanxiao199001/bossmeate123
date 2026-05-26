/**
 * 5-23 PR #231 — jcarindex 顺手回填 publisher (学会名升级).
 * 案例: Cultural Anthropology DB 是 "Wiley"(OpenAlex 平台名), 应该是 "American Anthropological Association".
 * 策略: jcarindex.publisher 通常给学会名, 覆盖 source=openalex 或 NULL 的, manual 不动.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-jcar-car.ts";

describe("PR #231: jcarindex publisher 回填", () => {
  it("JcarRecord 取 publisher", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/publisher\?: string \| null; \/\/ 出版商\/学会名/);
  });
  it("targets 查 publisher + fieldProvenance", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/publisher: journals\.publisher, fieldProvenance: journals\.fieldProvenance/);
  });
  it("只覆盖 source=openalex 或 NULL, manual 不动", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/const canOverwritePub = !currentPubSrc \|\| currentPubSrc === "openalex"/);
  });
  it("写 publisher + provenance=jcarindex + 不同值才写", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/"publisher":"jcarindex"/);
    expect(src).toMatch(/newPub !== j\.publisher/);
  });
  it("pubFilled 计数 + 报告", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/pubFilled \+= 1/);
    expect(src).toMatch(/顺手升级出版商/);
  });
});
