/**
 * 5-23 PR #162 — 内容质量 prompt 硬约束 + body fact validator 防回归 + 单元测试.
 *
 * 拆 spec: 仅 Phase 2 (prompt) + Phase 3 (validator extension) + Phase 4-lite (hasWarnings + feed filter).
 * Phase 1 (源分层) / Phase 4 quarantine status 留 backlog.
 */
import { describe, it, expect } from "vitest";
import { extractClaimedFacts, verifyClaimsAgainstDb } from "../services/skills/ai-content-validator.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #162 Phase 2: article-skill prompt 双重硬约束", () => {
  it("baseSystemPrompt 含 ##硬约束## 块 (system message 强约束)", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/baseSystemPrompt\s*=[\s\S]{0,500}##硬约束##/);
    expect(src).toMatch(/严禁从训练记忆调任何具体数字/);
    expect(src).toMatch(/##已知期刊数据##/); // system 提到 user 段名
  });

  it("user prompt: sparse known fields + 显式 ##未公开字段## 列表 (字段缺不填'未知')", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/const knownFields:\s*string\[\]/);
    expect(src).toMatch(/const unknownFields:\s*string\[\]/);
    // 不要回退到老的 "未知" 文本兜底 (那是 V7 老路, 让 AI 编造)
    expect(src).toMatch(/##未公开字段##/);
    expect(src).toMatch(/据公开资料尚无统一披露/);
    // ##已知期刊数据## 块在 user prompt
    expect(src).toMatch(/##已知期刊数据##[\s\S]{0,200}\$\{knownFields\.join/);
  });
});

describe("PR #162 Phase 3: extractClaimedFacts (body 数字提取)", () => {
  it("提取 IF (impactFactor) — 含 'IF 14.7' / '影响因子 14.7'", () => {
    const facts = extractClaimedFacts("这本期刊 IF 14.7, 而某竞品影响因子仅 2.6");
    const ifClaims = facts.filter((f) => f.field === "impactFactor");
    expect(ifClaims).toHaveLength(2);
    expect(ifClaims.map((f) => f.claimed as number).sort((a, b) => a - b)).toEqual([2.6, 14.7]);
  });

  it("提取 录用率 — '录用率 48%' / '录用率仅 8%'", () => {
    const facts = extractClaimedFacts("Nature 录用率仅 8%, Frontiers 录用率约 48%");
    const accept = facts.filter((f) => f.field === "acceptanceRate");
    expect(accept).toHaveLength(2);
    expect(accept.map((f) => f.claimed as number).sort((a, b) => a - b)).toEqual([0.08, 0.48]);
  });

  it("提取 审稿周期 — '审稿 5-8 周' / '审稿周期 4 周'", () => {
    const facts = extractClaimedFacts("审稿 5-8 周, 比同行快; 审稿周期 4 周");
    const cycles = facts.filter((f) => f.field === "reviewCycle");
    expect(cycles.map((f) => f.claimed).sort()).toEqual(["4", "5-8"]);
  });

  it("提取 创刊年 — '创刊 2010' / '成立于 2005'", () => {
    const facts = extractClaimedFacts("创刊 2010 年, Nature 成立于 1869");
    const years = facts.filter((f) => f.field === "foundingYear");
    expect(years.map((f) => f.claimed as number).sort((a, b) => a - b)).toEqual([1869, 2010]);
  });

  it("提取 出版国 — '出版国 瑞士' / '出版国：英国'", () => {
    const facts = extractClaimedFacts("出版国 瑞士。出版国：英国，发文量大");
    const countries = facts.filter((f) => f.field === "country");
    expect(countries.map((f) => f.claimed).sort()).toEqual(["瑞士", "英国"]);
  });

  it("去重 — 同 field+claimed 只算 1 次", () => {
    const facts = extractClaimedFacts("IF 14.7. 该刊 IF 14.7, 强烈推荐 IF 14.7 的 Nature");
    expect(facts.filter((f) => f.field === "impactFactor")).toHaveLength(1);
  });

  it("空 body / 无数字 → 0 issue", () => {
    expect(extractClaimedFacts("")).toEqual([]);
    expect(extractClaimedFacts("这是篇没数字的文章, 介绍投稿流程")).toEqual([]);
  });

  // 5-23 hotfix #163: journal-template 渲染 HTML 时 key/value 隔 <strong> 等标签 →
  // 老 regex 不跨标签匹配 → 漏识 "创刊年：</strong>2010" / "出版国：</strong>瑞士" 等 fabricated claim.
  // 修法: extractClaimedFacts 入口 strip HTML 标签为空格.
  it("strip HTML — key/value 被 <strong> 等标签隔时仍能 extract", () => {
    const htmlBody = `<p><strong>创刊年：</strong>2010</p><p><strong>出版国：</strong>瑞士</p><div>IF 2.6</div>`;
    const facts = extractClaimedFacts(htmlBody);
    const yearFact = facts.find((f) => f.field === "foundingYear");
    const countryFact = facts.find((f) => f.field === "country");
    const ifFact = facts.find((f) => f.field === "impactFactor");
    expect(yearFact?.claimed).toBe(2010);
    expect(countryFact?.claimed).toBe("瑞士");
    expect(ifFact?.claimed).toBe(2.6);
  });
});

describe("PR #162 Phase 3: verifyClaimsAgainstDb", () => {
  const journalDb = {
    impactFactor: 2.6,
    acceptanceRate: 0.48,
    reviewCycle: "5-8周",
    apcFee: 2900,
    foundingYear: 2010,
    country: "瑞士",
  };

  it("DB 全有值 + claim 在阈值内 → 0 issue", () => {
    const claims = extractClaimedFacts("IF 2.6, 录用率 48%, 审稿 5-8 周, 版面费 $2900, 创刊 2010, 出版国 瑞士");
    const issues = verifyClaimsAgainstDb(claims, journalDb);
    expect(issues).toEqual([]);
  });

  it("DB 字段 NULL + claim 非空 → 'fabricated' warning", () => {
    const claims = extractClaimedFacts("IF 14.7, 出版国 美国");
    const issues = verifyClaimsAgainstDb(claims, { impactFactor: null, country: null });
    expect(issues.length).toBe(2);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toMatch(/DB 该字段为空/);
  });

  it("IF 偏差 > 0.3 → warning 'stale_or_wrong'", () => {
    const claims = extractClaimedFacts("IF 3.5");
    const issues = verifyClaimsAgainstDb(claims, { impactFactor: 2.6 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/IF=3\.5 偏离 DB 2\.6/);
  });

  it("IF 偏差 ≤ 0.3 → 无 issue (年波动正常)", () => {
    const claims = extractClaimedFacts("IF 2.8");
    const issues = verifyClaimsAgainstDb(claims, { impactFactor: 2.6 });
    expect(issues).toEqual([]);
  });

  it("acceptanceRate 偏差 > 5% → warning", () => {
    const claims = extractClaimedFacts("录用率 60%");
    const issues = verifyClaimsAgainstDb(claims, { acceptanceRate: 0.48 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("acceptanceRate");
  });

  it("apcFee / foundingYear 完全相等才 OK", () => {
    expect(verifyClaimsAgainstDb(extractClaimedFacts("创刊 2010"), { foundingYear: 2010 })).toEqual([]);
    expect(verifyClaimsAgainstDb(extractClaimedFacts("创刊 2005"), { foundingYear: 2010 })).toHaveLength(1);
  });

  it("country 互含 OK ('瑞士' 含于 '瑞士联邦' / '瑞士' = '瑞士')", () => {
    expect(verifyClaimsAgainstDb(extractClaimedFacts("出版国 瑞士。"), { country: "瑞士联邦" })).toEqual([]);
    expect(verifyClaimsAgainstDb(extractClaimedFacts("出版国 美国。"), { country: "瑞士" })).toHaveLength(1);
  });
});

describe("PR #162 Phase 4-lite: validator gate wiring", () => {
  it("article-skill: generateJournalRecommendation 返 bodyHasWarnings + bodyFactIssues", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/bodyHasWarnings\?\s*:\s*boolean/);
    expect(src).toMatch(/bodyFactIssues\?\s*:\s*ValidationIssue\[\]/);
    // 调 extractClaimedFacts + verifyClaimsAgainstDb 在生成 article 后
    expect(src).toMatch(/extractClaimedFacts\(wrappedBody\)/);
    expect(src).toMatch(/verifyClaimsAgainstDb\(bodyClaims/);
    // return 含 bodyHasWarnings
    expect(src).toMatch(/return \{ article, quality, outline, bodyHasWarnings/);
  });

  it("article-skill: handle metadata 含 hasWarnings + validatorIssues 字段", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/hasWarnings:\s*!!bodyHasWarnings/);
    expect(src).toMatch(/validatorIssues:\s*bodyFactIssues && bodyFactIssues\.length > 0 \? bodyFactIssues : undefined/);
  });

  it("feed-service: /recommendations SQL filter hasWarnings (IS DISTINCT FROM 'true')", async () => {
    const src = await readSrc("../services/recommendation/feed-service.ts");
    expect(src).toMatch(/c\.metadata->>'hasWarnings' IS DISTINCT FROM 'true'/);
  });
});
