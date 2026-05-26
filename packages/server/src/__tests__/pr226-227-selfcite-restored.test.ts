/**
 * 5-23 PR #226/#227 — 自引率从 ablesci 详情页恢复 (替代旧 OpenAlex 不准值).
 * #226 抓取: 按 ISSN 搜→详情 id→regex 抠"自引率 X.XX%"→写 0-1 ratio + provenance=ablesci.
 *   先清非 ablesci 来源的旧值, 保证后续显示侧任何非 null 即 ablesci 真值.
 * #227 显示: renderSelfCitationBadge 重启, 读 selfCitationRate 直接渲染, AI prose 仍止血.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-ablesci-selfcite.ts";
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #226: 抓取脚本", () => {
  it("先清除非 ablesci 旧值 (避免旧 OpenAlex 残留误展示)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/UPDATE journals[\s\S]{0,200}?self_citation_rate = NULL[\s\S]{0,200}?field_provenance->>'selfCitationRate' IS DISTINCT FROM 'ablesci'/);
  });
  it("搜索→详情两步抓 + 解析自引率 %", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/function parseDetailId/);
    expect(src).toMatch(/function parseSelfCitation/);
    expect(src).toMatch(/自引率\[\\s:：\]\*\(\[0-9\]\+\\\.\?\[0-9\]\*\)\\s\*%/);
  });
  it("写 0-1 ratio + provenance=ablesci", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/return pct \/ 100;/);
    expect(src).toMatch(/"selfCitationRate":"ablesci"/);
  });
  it("礼貌限速 + 错误退避", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/await sleep\(800\)/);
    expect(src).toMatch(/await sleep\(2500\)/);
  });
});

describe("PR #227: 徽章重启", () => {
  it("renderSelfCitationBadge 读 journal.selfCitationRate, 不再 return ''", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/PR #227[\s\S]{0,180}?const rate = journal\.selfCitationRate;/);
  });
  it("仅非空且 >0 才渲染 (空就静默, 不显空白徽章)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(typeof rate !== "number" \|\| rate <= 0\) return "";/);
  });
  it("展示 % + 低/中/高风险 + 数据来源 ablesci", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/数据来源：ablesci/);
    expect(src).toMatch(/pct < 5 \? "低" : pct < 15 \? "中" : "高"/);
  });
});
