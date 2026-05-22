/**
 * 5-22 PR #210 — 砍 OpenAlex 派生不准数据 (老韩定调: OpenAlex 派生准确度极低).
 * 砍: scope_details(收稿范围/学科分布 concepts 噪声)、citing 引用前10、subject-distribution 图、CAR.
 * 三处闭环: 模板止血 + prompt 不喂 + orchestrator 停抓取. 保留事实型 publisher/官网/discipline/发文量.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";
const ARTICLE = "../services/skills/article-skill.ts";
const ORCH = "../services/journal-enricher/orchestrator.ts";

describe("PR #210: 模板止血", () => {
  it("renderScopeDetailsBlock 整块不渲染", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderScopeDetailsBlock\(journal: JournalInfo\): string \{[\s\S]{0,260}?void journal;\s*\n\s*return "";\s*\n\}/);
  });
  it("renderCitingJournalsPie 整块不渲染", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderCitingJournalsPie\(journal: JournalInfo\): string \{[\s\S]{0,200}?void journal;\s*\n\s*return "";\s*\n\}/);
  });
  it("subject-distribution 图不再接入 section", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).not.toMatch(/^\s*if \(typesSet\.has\("subject-distribution"\)\) sections\.push/m);
  });
});

describe("PR #210: prompt 不再喂 OpenAlex 派生数据", () => {
  it("CAR/引用前10/收稿concepts/学科分布 全从 enrichmentLines 移除", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).not.toMatch(/enrichmentLines\.push\(`- 近 5 年 CAR 指数/);
    expect(src).not.toMatch(/enrichmentLines\.push\(`- 引用前 10 期刊/);
    expect(src).not.toMatch(/enrichmentLines\.push\(`- 收稿分类/);
    expect(src).not.toMatch(/enrichmentLines\.push\(`- 学科分布/);
  });
  it("scopeAndCitations 指令禁提 OpenAlex 派生, 无数据返回 null", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/OpenAlex 派生数据已全部下线/);
    expect(src).toMatch(/该字段直接返回 null/);
  });
});

describe("PR #210: orchestrator 停抓取", () => {
  it("scope/citing/car 三个 tryExtract 已注释停用", async () => {
    const src = await readSrc(ORCH);
    expect(src).toMatch(/停抓 OpenAlex 派生不准数据/);
    expect(src).not.toMatch(/^\s*tryExtract\("scope_details"/m);
    expect(src).not.toMatch(/^\s*tryExtract\("citing_journals_top10"/m);
    expect(src).not.toMatch(/^\s*tryExtract\("car_index_history"/m);
  });
});
