/**
 * 5-20 PR #185 — 标题第二轮: 加痛点钩子 (运营反馈"标题太干没吸引力").
 * 钩子戳真实纠结(该不该投/门槛/避坑/预警), 但钩子数据必须真实(防 #3 编分区教训).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #185: 标题钩子型风格", () => {
  it("titleStyles 含钩子型 (决策纠结/避坑/适配人群)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/决策纠结型\(钩子\)/);
    expect(src).toMatch(/避坑提醒型\(钩子\)/);
    expect(src).toMatch(/适配人群型\(钩子\)/);
  });
  it("有 IF 时加门槛评估钩子", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/门槛评估型\(钩子\)/);
    expect(src).toMatch(/普通课题组冲得动吗/);
  });
  it("预警刊加专属避雷钩子 (基于 isWarningList)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/if \(journal\.isWarningList\) \{/);
    expect(src).toMatch(/预警提示型\(钩子,仅预警刊\)/);
  });
  it("保留信息型多样性 (学科盘点/趋势)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/学科盘点型/);
    expect(src).toMatch(/趋势分析型/);
  });
});

describe("PR #185: 钩子真实性约束 (防 #3 编分区)", () => {
  it("约束#12: 钩子数据必须真实, 严禁为吸睛编分区/录用率", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/钩子要真/);
    expect(src).toMatch(/严禁为吸睛编造分区/);
  });
  it("约束#13: 禁标题党词汇 (必看/绝了/封神)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/禁夸张营销/);
    expect(src).toMatch(/投稿前必看/);  // 在禁止列表里
  });
});
