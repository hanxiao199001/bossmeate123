/**
 * 5-20 PR #184 — 内容质量 v2 (运营反馈 4 大类). file-content regression.
 *
 * 问题1 非SCI当SCI写  → 收录状态注入 + 无证据禁称SCI
 * 问题2 标题(vs占位/截断/中英混杂/含名/太干) → 标题硬约束重写
 * 问题3 封面不一致 → renderHeroBlock 无cover占位兜底
 * 问题4 英文多+AI感话术 → 砍元话术 + 中文为主 + 深度章节null
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";
const RECOMMENDER = "../services/recommendation/journal-recommender.ts";

describe("PR #184 问题1: SCI 收录状态注入", () => {
  it("article-skill: knownFields 注入收录情况", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/收录情况/);
    expect(src).toMatch(/indexStatuses/);
  });
  it("article-skill: 无收录证据时禁称 SCI/SSCI/核心/顶刊", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/无 SCI\/SSCI\/中文核心 收录证据/);
    expect(src).toMatch(/严禁.*称其为/);
  });
  it("recommender: 候选查询加 SCI 过滤 (wosLevel + IF)", async () => {
    const src = await readSrc(RECOMMENDER);
    expect(src).toMatch(/wosLevel'\] ILIKE '%SCIE%'|wosLevel' ILIKE '%SCIE%/);
    expect(src).toMatch(/sciWhere/);
    expect(src).toMatch(/fallback 放宽全部期刊/);
  });
});

describe("PR #184 问题2: 标题策略重写", () => {
  it("article-skill: 期刊名可选 (推翻必须含名)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/期刊名可选/);
    expect(src).not.toMatch(/标题必须包含期刊英文全名/);
  });
  it("article-skill: 禁悬空对比 (修 vs 占位空)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/严禁出现悬空对比/);
  });
  it("article-skill: 中文为主 + 要有钩子", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/标题以中文为主/);
    expect(src).toMatch(/必须有痛点或悬念/);
  });
});

describe("PR #184 问题3: 封面占位兜底", () => {
  it("shunshi-template: renderHeroBlock 无 cover 用 PLACEHOLDER_BG 占位卡", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/background:\$\{PLACEHOLDER_BG\}/);
    // 占位卡含期刊名大字
    expect(src).toMatch(/占位卡/);
  });
});

describe("PR #184 问题4: 砍 AI 感 + 中文化", () => {
  it("article-skill: unknownBlock 砍 '据公开资料尚无统一披露' 教唆", async () => {
    const src = await readSrc(ARTICLE);
    // 教唆性措辞已删 (改为'完全不要提及')
    expect(src).toMatch(/完全不要提及这些字段/);
  });
  it("article-skill: 显式禁止元话术", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/严禁元话术/);
    expect(src).toMatch(/无法详细分析/);  // 在禁止列表里
  });
  it("article-skill: 正文中文为主要求", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/正文以\*\*中文为主\*\*|正文.*中文为主/);
  });
  it("article-skill: 深度章节无数据返回 null (不写空话)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/无 IF 历史数据时返回 null/);
    expect(src).toMatch(/绝不要\*\*写"由于缺乏数据无法分析"|绝不要.*写"由于缺乏/);
  });
});
