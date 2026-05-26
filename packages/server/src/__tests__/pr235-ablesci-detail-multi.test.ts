/**
 * 5-23 PR #235 — ablesci 详情页扩抓 录用率 + 审稿周期 (合 PR #226 自引率, 一次详情页 3 字段).
 * 探针结果:
 *   - 自引率: 精确数字 ✅
 *   - 审稿周期: "平均24月" ✅
 *   - 录用率: 模糊词"较易/较难" ⚠️ — 加 acceptance_difficulty varchar 共存 acceptance_rate (real)
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-ablesci-detail.ts";
const SCHEMA = "../models/schema.ts";
const MIGRATE = "../models/migrate.ts";
const ARTICLE = "../services/skills/article-skill.ts";
const SHUNSHI = "../services/publisher/adapters/shunshi-style-template.ts";
const COLLECTOR = "../services/data-collection/journal-content-collector.ts";

describe("PR #235: scraper 多字段", () => {
  it("4 个 parser 都定义", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/function parseSelfCitation/);
    expect(src).toMatch(/function parseAcceptanceRate/);
    expect(src).toMatch(/function parseAcceptanceDifficulty/);
    expect(src).toMatch(/function parseReviewCycle/);
  });
  it("parseAcceptanceDifficulty: 5 档标准化 (容易/较易/中等/较难/困难/极难)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/"易": "容易"/);
    expect(src).toMatch(/"较易": "较易"/);
    expect(src).toMatch(/"中": "中等"/);
    expect(src).toMatch(/"较难": "较难"/);
    expect(src).toMatch(/"难": "困难"/);
  });
  it("--probe 模式打印两路径 (精确百分比 + 模糊词)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/录用率\(精确\)/);
    expect(src).toMatch(/投稿难度\(模糊\)/);
  });
  it("provenance gate: 不覆盖 manual / letpub 真值 (acceptanceDifficulty)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/!prov\?\.acceptanceDifficulty \|\| prov\.acceptanceDifficulty === "openalex"/);
  });
});

describe("PR #235: schema + migrate", () => {
  it("schema 加 acceptanceDifficulty varchar(20)", async () => {
    const src = await readSrc(SCHEMA);
    expect(src).toMatch(/acceptanceDifficulty: varchar\("acceptance_difficulty", \{ length: 20 \}\)/);
  });
  it("migrate 加 idempotent ALTER TABLE", async () => {
    const src = await readSrc(MIGRATE);
    expect(src).toMatch(/column_name = 'acceptance_difficulty'/);
    expect(src).toMatch(/ALTER TABLE journals ADD COLUMN acceptance_difficulty VARCHAR\(20\)/);
  });
});

describe("PR #235: knownFields + 渲染层 fallback", () => {
  it("collector JournalInfo 加 acceptanceDifficulty", async () => {
    const src = await readSrc(COLLECTOR);
    expect(src).toMatch(/acceptanceDifficulty: string \| null/);
    expect(src).toMatch(/acceptanceDifficulty: \(journal as any\)\.acceptanceDifficulty/);
  });
  it("article-skill knownFields 优先 acceptanceRate, 兜底 acceptanceDifficulty", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/else if \(\(journal as \{ acceptanceDifficulty\?: string \| null \}\)\.acceptanceDifficulty\)/);
    expect(src).toMatch(/- 投稿难度：/);
    expect(src).toMatch(/ablesci 定性评价, 非精确录用率/);
  });
  it("shunshi 投稿建议块加 ablesci 5 档颜色映射", async () => {
    const src = await readSrc(SHUNSHI);
    expect(src).toMatch(/if \(ad === "容易"\)/);
    expect(src).toMatch(/if \(ad === "较难"\)/);
    expect(src).toMatch(/if \(ad === "困难" \|\| ad === "极难"\)/);
    expect(src).toMatch(/ablesci 评级/);
  });
  it("shunshi: ar + ad + rc 都空才 skip 整块", async () => {
    const src = await readSrc(SHUNSHI);
    expect(src).toMatch(/if \(ar == null && ad == null && rc == null\) return ""/);
  });
});
