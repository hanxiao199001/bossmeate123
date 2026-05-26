/**
 * 5-23 PR #235 — ablesci 详情页扩抓 录用率 + 审稿周期 (合 PR #226 自引率, 一次详情页 3 字段).
 * 现状 acceptance_rate/review_cycle 覆盖率 48/5012 (1.0%), 是 5000 池最大短板.
 * 新文件 scrape-ablesci-detail.ts 取代 scrape-ablesci-selfcite.ts (保留兼容).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-ablesci-detail.ts";

describe("PR #235: ablesci 详情多字段 scraper", () => {
  it("3 个 parser 都定义 (自引率/录用率/审稿周期)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/function parseSelfCitation/);
    expect(src).toMatch(/function parseAcceptanceRate/);
    expect(src).toMatch(/function parseReviewCycle/);
  });
  it("自引率 parser 返回 0-1 ratio (沿 PR #226 口径)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/自引率\[\\s:：\]\*\(\[0-9\]\+\\\.\?\[0-9\]\*\)\\s\*%/);
    expect(src).toMatch(/return pct \/ 100/);
  });
  it("录用率 parser: 词典含 录用比例/录用率/接受率/接受比例", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/录用比例\|录用率\|接受率\|接受比例/);
  });
  it("审稿周期 parser: 词典 + 单位校验 (月/周/天/年)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/平均审稿速度\|审稿速度\|审稿周期\|审稿时长/);
    expect(src).toMatch(/月\|周\|天\|年\|month\|week\|day/);
  });
  it("--probe 模式: 不入库, 打印命中 + 上下文", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/--probe/);
    expect(src).toMatch(/async function probeOne/);
    expect(src).toMatch(/上下文/);
  });
  it("provenance gate: 不覆盖 manual / letpub 真值", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/!prov\?\.acceptanceRate \|\| prov\.acceptanceRate === "openalex"/);
    expect(src).toMatch(/!prov\?\.reviewCycle \|\| prov\.reviewCycle === "openalex"/);
  });
  it("step 0 清旧值时保留 letpub/manual provenance (只清无标记)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/field_provenance->>'acceptanceRate' IS NULL/);
    expect(src).toMatch(/field_provenance->>'reviewCycle' IS NULL/);
  });
  it("审稿周期文本截 ≤ 48 字符 (varchar 50 列宽 buffer)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/v\.length > 48/);
  });
});
