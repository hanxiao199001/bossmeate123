/**
 * 5-21 PR #200 — 标题选题库扩充: 学往期爆款"句式结构", 数据严守真实.
 * 老韩定调: "以数据真实性为准, 只学习它的标题结构, 不要学习它的夸大的内容".
 * 加 痛点提问型 + 信息差揭秘型 (来自往期 SCI 公众号标题骨架), 并强化 #13 禁夸张/禁虚假宣传约束.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #200: 新增爆款句式 (痛点提问/信息差)", () => {
  it("titleStyles 含痛点提问型", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/痛点提问型\(钩子\)/);
  });
  it("titleStyles 含信息差揭秘型", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/信息差揭秘型\(钩子\)/);
  });
  it("新句式保留 PR #200 来源标注 (学结构非学夸大)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/PR #200, 学往期爆款"句式结构", 数据严守真实/);
  });
  it("信息差型显式要求不得编造", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/不得编造/);
  });
});

describe("PR #200: 强化禁夸张/禁虚假宣传约束 (#13)", () => {
  it("#13 升级为 禁夸张营销/禁虚假宣传", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/禁夸张营销\/禁虚假宣传/);
  });
  it("禁用爆款里的放水/造假暗示词", async () => {
    const src = await readSrc(ARTICLE);
    for (const w of ["神刊", "水刊", "包过", "白嫖", "放水", "零门槛", "灌水", "捡漏", "水王", "稳过", "轻松发"]) {
      expect(src).toContain(w);
    }
  });
  it("明确允许学句式结构但禁搬夸大用词", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/可学往期爆款的"提问\/悬念\/盘点"句式结构/);
    expect(src).toMatch(/不得搬用其夸大用词/);
  });
});
