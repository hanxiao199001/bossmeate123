/**
 * 5-22 PR #209 — IF<=0 视为"无 IF" (堵占位 0 泄漏).
 * 根因: IF=0 是占位值(中文法学刊等无 SCI IF), 但 hasIF/ifText/模板只判 !=null,
 *   0 会泄漏成 "最新影响因子 0" / "IF 0.0 的 XX" 误导用户.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";
const COLLECTOR = "../services/data-collection/journal-content-collector.ts";

describe("PR #209: IF<=0 当无 IF", () => {
  it("hasIF 要求 > 0", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/const hasIF = journal\.impactFactor != null && journal\.impactFactor > 0;/);
  });
  it("ifText 要求 > 0, 否则 N/A", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/journal\.impactFactor != null && journal\.impactFactor > 0\) \? journal\.impactFactor\.toFixed\(1\) : "N\/A"/);
  });
  it("模板 IF 区块 IF<=0 整块 skip", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(if_ == null \|\| if_ <= 0\) return "";/);
  });
  it("同档对比 fmtIF 对 <=0 显示 —", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/typeof v === "number" && v > 0 \? v\.toFixed\(1\) : "—"/);
  });
  it("同档对比 peer 查询排除 IF=0", async () => {
    const src = await readSrc(COLLECTOR);
    expect(src).toMatch(/gt\(journals\.impactFactor, 0\)/);
  });
});
