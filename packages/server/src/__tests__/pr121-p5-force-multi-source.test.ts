/**
 * PR #121 P5 强制 multi_source 期刊池 fix 防回归。
 *
 * Bug：PR #120 实测 17 篇 medical article 全用 AI 编造期刊（journalId NULL），
 *      触发 ContentDetailPage ⚠️ AI 推测警告横幅 → 5-22 demo blocker。
 *
 * Fix:
 *   1. cron-handler 调 db.select(journals).where(dataSource='multi_source_verified')
 *      轮询分配 journalId 到每个 batch_row
 *   2. article-skill 检测 context.metadata.journalId → 直接 SELECT 跳 collector V6
 *      → 强制走预选的 multi_source 期刊
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR #121 cron-handler: 强制 multi_source 池轮询", () => {
  const src = readSrc("services/industry-monthly/cron-handler.ts");

  it("import 含 desc + journals", () => {
    expect(src).toMatch(/import\s*\{[^}]*desc[^}]*\}\s*from\s*["']drizzle-orm["']/);
    expect(src).toMatch(/import\s*\{[^}]*journals[^}]*\}\s*from\s*["']\.\.\/\.\.\/models\/schema/);
  });

  it("SELECT multi_source_verified 池 + ORDER BY confidence DESC", () => {
    expect(src).toMatch(/eq\(journals\.dataSource,\s*"multi_source_verified"\)/);
    expect(src).toMatch(/orderBy\(desc\(journals\.confidence\)\)/);
  });

  it("pickJournalId 轮询 (i % multiPool.length)", () => {
    expect(src).toMatch(/multiPool\[i\s*%\s*multiPool\.length\]/);
  });

  it("CsvRow.journalId 用 pickJournalId(i)（不再固定 null）", () => {
    expect(src).toMatch(/journalId:\s*pickJournalId\(i\)/);
    expect(src).not.toMatch(/journalId:\s*null,\s*\/\/ 缺则 article-skill AI 推荐/);
  });

  it("含 PR #121 root cause 注释", () => {
    expect(src).toMatch(/PR #121.*强制|multi_source_verified 池|AI 编造期刊/);
  });
});

describe("PR #121 article-skill: metadata.journalId 优先分支", () => {
  const src = readSrc("services/skills/article-skill.ts");

  it("含 explicitJournalId = context.metadata?.journalId 提取", () => {
    expect(src).toMatch(/const\s+explicitJournalId\s*=\s*context\.metadata\?\.journalId/);
  });

  it("有 journalId 时 SELECT journals + 跳 collectJournalContent", () => {
    expect(src).toMatch(/if\s*\(explicitJournalId\)/);
    expect(src).toMatch(/db\.select\(\)[\s\S]{0,40}\.from\(journals\)/);
    expect(src).toMatch(/eq\(journals\.id,\s*explicitJournalId\)/);
  });

  it("含 PR #121 注释（防 refactor 误恢复 collector V6 优先）", () => {
    expect(src).toMatch(/PR #121.*P5/);
    expect(src).toMatch(/跳 collector V6|caller 已 P3\/cron 预选/);
  });

  it("collectionResult 兜底回 collectJournalContent（journalId 缺时仍走原流程）", () => {
    // 仅当 collectionResult 仍 undefined 时调 collectJournalContent
    expect(src).toMatch(/if\s*\(!collectionResult\)\s*try\s*\{[\s\S]{0,200}collectJournalContent/);
  });
});
