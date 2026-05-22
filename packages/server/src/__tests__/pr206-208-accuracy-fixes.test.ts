/**
 * 5-22 PR #206/#207/#208 — 运营反馈 5 问题的准确性/一致性修复:
 *  #206 自引率止血 (OpenAlex 不准, 偏差 2-7pt, 同 CAR)
 *  #207 SCIE/SCI 称谓修正 (SCIE 是 SCI 现行名, 严禁写"SCIE 未被 SCI 收录")
 *  #208 官网锚文本显示域名 + publisher OpenAlex 回填
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";
const BACKFILL = "../scripts/backfill-website-from-openalex.ts";

describe("PR #206: 自引率止血", () => {
  it("自引率徽章渲染早返回空 (止血)", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderSelfCitationBadge[\s\S]{0,200}?return "";/);
    expect(src).toMatch(/PR #206[\s\S]{0,80}?自引率止血/);
  });
  it("cautions 不再输出自引率偏高项", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).not.toMatch(/items\.push\("自引率偏高/);
  });
  it("prompt 不再喂自引率数值, 且禁 AI 提自引率", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).not.toMatch(/，自引率：\$\{\(journal\.promptCitingTop10\.selfCitationRate/);
    expect(src).toMatch(/严禁提及\/编造"自引率"数值/);
  });
  it("避坑主线 gating 去掉 selfCitationRate 条件", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/if \(journal\.isWarningList\) \{\n\s*angleCandidates\.push\(\{ key: "避坑主线"/);
  });
});

describe("PR #207: SCIE/SCI 称谓", () => {
  it("有 SCIE 时注入同义说明", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/SCIE 是 SCI 的现行名称|SCIE 是 SCI 的现行官方名称/);
    expect(src).toMatch(/被 SCIE 收录即被 SCI 收录/);
  });
  it("加硬约束 #14 禁错误对立表述", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/14\. 【SCIE 称谓正确】/);
    expect(src).toMatch(/严禁.{0,40}SCIE 不是 SCI/);
  });
});

describe("PR #208: 官网域名显示 + publisher 回填", () => {
  it("锚文本用 hostname 而非笼统'查看官网'", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/new URL\(journal\.website\)\.hostname/);
    expect(src).not.toMatch(/journal\.website\.length > 50 \? "查看官网 →"/);
  });
  it("backfill 脚本同时回填 website + publisher (一次 OpenAlex)", async () => {
    const src = await readSrc(BACKFILL);
    expect(src).toMatch(/extractPublisherFromOpenAlex/);
    expect(src).toMatch(/or\(isNull\(journals\.website\), isNull\(journals\.publisher\)\)/);
  });
  it("脚本仍只走 OpenAlex, import 行无 LetPub/scrapling", async () => {
    const src = await readSrc(BACKFILL);
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    for (const l of importLines) expect(l.toLowerCase()).not.toMatch(/letpub|scrapling|crawler/);
  });
});
