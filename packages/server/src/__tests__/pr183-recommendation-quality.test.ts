/**
 * 5-20 PR #183 — 每日推荐质量修复 (file-content regression).
 *
 * 4 个 5-20 用户反馈 bug:
 *   #34 标题硬编码 "2025年"  → 动态 currentYear
 *   #35 同批期刊重复 (IEEE x2) → daily-cron 批内唯一 (MAX_PER_JOURNAL_24H 2→1 + usedJournalIds 守卫)
 *   #36 标题模板撞车 (性价比之王 x2 / 最火研究方向 x3) → 砍高撞车措辞 + prompt 反照抄
 *   #36 IF N/A 裸露标题 → 无 IF 期刊不放含 IF 风格
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

const ARTICLE = "../services/skills/article-skill.ts";
const CRON = "../services/recommendation/daily-cron.ts";

describe("PR #183: 标题年份动态化 (#34)", () => {
  it("article-skill: 用 new Date().getFullYear() 不硬编码 2025", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/const currentYear = new Date\(\)\.getFullYear\(\)/);
    // titleStyles 区不再有硬编码 "2025年"
    const titleBlock = src.slice(src.indexOf("标题多元化"), src.indexOf("chosenStyle ="));
    expect(titleBlock).not.toMatch(/2025年/);
  });

  it("article-skill: prompt 硬约束含年份动态规则", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/一律用 \$\{currentYear\}/);
  });
});

describe("PR #183: 标题模板防撞车 (#36)", () => {
  it("article-skill: 砍 '性价比之王' / '最火研究方向' 高撞车措辞", async () => {
    const src = await readSrc(ARTICLE);
    const titleBlock = src.slice(src.indexOf("标题多元化"), src.indexOf("chosenStyle ="));
    expect(titleBlock).not.toMatch(/性价比之王/);
    expect(titleBlock).not.toMatch(/最火研究方向/);
  });

  it("article-skill: prompt 含反照抄指令", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/防撞车/);
    expect(src).toMatch(/严禁照搬其措辞/);
  });
});

describe("PR #183: IF N/A 不裸露标题 (#36)", () => {
  it("article-skill: 含 IF 的风格仅 hasIF 时 push", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/const hasIF = journal\.impactFactor != null/);
    expect(src).toMatch(/if \(hasIF\) \{/);
    expect(src).toMatch(/无 IF 不提 IF/);
  });
});

describe("PR #183: daily-cron 批内期刊唯一 (#35)", () => {
  it("daily-cron: MAX_PER_JOURNAL_24H = 1", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/MAX_PER_JOURNAL_24H\s*=\s*1/);
  });

  it("daily-cron: 选取循环含 usedJournalIds.has 唯一守卫", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/if \(usedJournalIds\.has\(r\.id\)\) continue/);
  });

  it("daily-cron: 兜底不再强塞 recs[0] (改 find 未用过的)", async () => {
    const src = await readSrc(CRON);
    expect(src).not.toMatch(/journalId = recs\[0\]\?\.id \?\? null/);
    expect(src).toMatch(/recs\.find\(\(r\) => !usedJournalIds\.has\(r\.id\)\)/);
  });
});
