/**
 * 5-23 PR #233 — 双收录 SCIE+SSCI 时 scieNote 列全 + 后置 lint 拦"未被 X 收录" 禁词.
 * 案例: ANZJPH wos_level="SCIE, SSCI" 双收录, PR #230 regex 只取首个=SCIE,
 *   AI 写"目前没有被 SCI/SSCI 收录, 投稿前务必确认单位是否认可". 修法:
 *   1) prompt: matchAll 列全所有命中等级, 强化"多重收录"表述指引
 *   2) validator: step 11 — DB wosLevel 已知 SCIE/SSCI 等时, 扫文章命中禁词 → error 拦截
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";
const VALIDATOR = "../services/skills/ai-content-validator.ts";

describe("PR #233: 双收录 scieNote 列全", () => {
  it("matchAll 取所有命中 WOS 等级 (含 SCIE+SSCI 双收录)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/matchAll\(\/\\b\(SCIE\|SSCI\|AHCI\|ESCI\)\\b\/gi\)/);
    expect(src).toMatch(/const wosTags = Array\.from\(new Set/);
  });
  it("scieNote 用 wosTagsJoin 列全 + 多重收录提示", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/该刊被 \$\{wosTagsJoin\} 收录/);
    expect(src).toMatch(/该刊为多重收录/);
    expect(src).toMatch(/"目前没有被 SCI\/SSCI 收录"/);
  });
});

describe("PR #233: validator step 11 后置 lint", () => {
  it("validateAIContent 新增 step 11 调用", async () => {
    const src = await readSrc(VALIDATOR);
    expect(src).toMatch(/\/\/ ---- 11\. 收录状态自相矛盾 \(PR #233\)/);
    expect(src).toMatch(/validateIndexStatusContradiction\(corrected, journal, issues\)/);
  });
  it("validateIndexStatusContradiction 函数定义 + 禁词正则", async () => {
    const src = await readSrc(VALIDATOR);
    expect(src).toMatch(/function validateIndexStatusContradiction/);
    expect(src).toMatch(/未被\|没有被\|尚未被\|目前没有被\|不被\|未获/);
    expect(src).toMatch(/非\\s\*\(SCI\|SSCI/);
    expect(src).toMatch(/投稿前\.\{0,10\}\?确认\.\{0,10\}\?单位/);
  });
  it("DB wosLevel 含 SCIE/SSCI 才触发 (无收录证据不误伤)", async () => {
    const src = await readSrc(VALIDATOR);
    expect(src).toMatch(/const hasWosIndex = \/\\b\(SCIE\|SSCI\|AHCI\|ESCI\)\\b\/i\.test\(wosLevel\)/);
    expect(src).toMatch(/if \(!hasWosIndex\) return/);
  });
  it("issue severity=error + autoCorrected=false (走 hasWarnings 排除推荐池)", async () => {
    const src = await readSrc(VALIDATOR);
    expect(src).toMatch(/severity: "error"/);
    expect(src).toMatch(/autoCorrected: false/);
  });
  it("stats totalChecks 从 10 升 11", async () => {
    const src = await readSrc(VALIDATOR);
    expect(src).toMatch(/totalChecks: issues\.length > 0 \? issues\.length : 11/);
    expect(src).toMatch(/passedChecks: 11 - issues\.length/);
  });
});
