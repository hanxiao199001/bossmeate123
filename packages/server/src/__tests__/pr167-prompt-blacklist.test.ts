/**
 * 5-23 PR #167 — prompt 黑名单 4 字段 防回归.
 *
 * 配合 PR #162 双重硬约束 + PR #163 validator HTML strip + PR #164 metadata persist,
 * 这个 PR 在 prompt 层加 ##禁止字段## 黑名单, 让 AI 不爱写 founding年/country/具体录用率/具体审稿周.
 *
 * 双保险: PR #167 prompt 主拦, validator 仍跑 (兜底).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #167: prompt 黑名单 4 字段", () => {
  it("user prompt 含 ##禁止字段## 段 + 4 字段全列出", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/blacklistBlock/);
    expect(src).toMatch(/##禁止字段##/);
    // 4 字段全 列
    expect(src).toMatch(/创刊年.*founded in.*创办于/s);
    expect(src).toMatch(/出版国.*出版地.*based in/s);
    expect(src).toMatch(/录用率[\s\S]{0,200}仅允许"较高/);
    expect(src).toMatch(/审稿周期[\s\S]{0,200}仅允许"较快/);
  });

  it("user prompt: blacklistBlock 插入 ##已知期刊数据## 后 + unknownBlock 后", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    // 渲染顺序: ##已知期刊数据## → knownFields → unknownBlock → blacklistBlock → enrichmentBlock
    expect(src).toMatch(/\$\{unknownBlock\}\$\{blacklistBlock\}\$\{enrichmentBlock\}/);
  });

  it("baseSystemPrompt 加强 — 含 '特别注意' + 4 字段 + 'backfill 实测 0 源覆盖'", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/baseSystemPrompt[\s\S]{0,600}特别注意[\s\S]{0,400}4 字段/s);
    expect(src).toMatch(/backfill 实测 0 源覆盖/);
    // 4 字段强化提示
    expect(src).toMatch(/创刊年.*禁止提具体年份/s);
    expect(src).toMatch(/出版国.*禁止具体国家名/s);
    expect(src).toMatch(/具体录用率百分比/);
    expect(src).toMatch(/具体审稿周数/);
  });

  it("模糊词 仍允许 — 兜底语在 prompt 里明确", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    // 允许 list (模糊词不被 prompt 禁)
    expect(src).toMatch(/较高.*较低.*适中.*相对宽松/s);
    expect(src).toMatch(/较快.*较慢.*标准/s);
    expect(src).toMatch(/历史悠久的/);
    expect(src).toMatch(/国际期刊.*业内/s);
  });

  it("validator 仍作双保险 — extractClaimedFacts + verifyClaimsAgainstDb 不动", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    // PR #162-#164 链 (validator gate) 不动
    expect(src).toMatch(/extractClaimedFacts\(wrappedBody\)/);
    expect(src).toMatch(/verifyClaimsAgainstDb\(bodyClaims/);
    expect(src).toMatch(/bodyHasWarnings/);
  });

  // 5-23 PR #168 hotfix: in-memory journal.foundingYear/country 被 ensureJournalEnriched
  // AI 编填充, validator 必须 SELECT DB 真值不能用 in-memory
  it("PR #168: validator 用 DB 真值 (SELECT journals) 不用 in-memory journal", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    // dbJournalTruth 变量存在
    expect(src).toMatch(/dbJournalTruth/);
    // foundingYear / country 默认 null (不信 in-memory)
    expect(src).toMatch(/foundingYear:\s*null,[\s\S]{0,80}country:\s*null/);
    // 显式 SELECT DB
    expect(src).toMatch(/\.select\(\{[\s\S]{0,300}foundingYear:\s*journals\.foundingYear/);
    // verify 用 dbJournalTruth 而非 in-memory
    expect(src).toMatch(/verifyClaimsAgainstDb\(bodyClaims,\s*dbJournalTruth\)/);
  });
});
