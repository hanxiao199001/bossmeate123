/**
 * 7-28 (#2/#3) — 国内刊分支死代码修复 + 复合影响因子接进生成。
 *
 * 背景: article-skill 旧判定 `isDomesticJournal = cats.length>0 && !(ifText && !ifText.includes("未知"))`,
 *   无 IF 时 ifText="N/A"(恒真值, 不含"未知") → 表达式恒 false → 7-21 改动3 的国内刊分支从未走到过;
 *   同一个 "N/A" 问题还把"影响因子：N/A"塞进 ##已知期刊数据##。
 *   另: 万方回填的 composite_impact_factor(447 本医学国内刊)有列但生成从不使用。
 *
 * 判定/指引已抽为纯函数 buildDomesticJournalGuidance —— 本文件直接断言 prompt 组装结果,
 * 再用源码结构守卫锁方法内的接线(generateJournalAIContent 强依赖 LLM, 跑不了端到端)。
 */
import { describe, it, expect } from "vitest";
import { buildDomesticJournalGuidance } from "../services/skills/article-skill.js";

async function readSrc(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL("../services/skills/article-skill.ts", import.meta.url), "utf8");
}

describe("buildDomesticJournalGuidance — 国内刊判定(修 'N/A' 恒真值死代码)", () => {
  it("有中文核心目录 + 无 IF(null) → 是国内刊, 分支真的会走到(旧代码这里恒 false)", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["pku-core", "cssci"], impactFactor: null });
    expect(r.isDomestic).toBe(true);
    expect(r.guidance).toContain("本刊是【国内核心期刊】");
    expect(r.guidance).toContain("600-800 字");
    expect(r.guidance).toContain("北大核心 + CSSCI 双核心");
  });

  it("IF=0 占位值(PR #209 语义)同样算无 IF → 国内刊", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["cscd"], impactFactor: 0 });
    expect(r.isDomestic).toBe(true);
  });

  it("有真实 IF(>0) 的骑墙刊 → 不是国内刊分支(走国际口径), 复合IF 也不注入", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["pku-core", "sci-core"], impactFactor: 4.3, compositeImpactFactor: 1.2 });
    expect(r.isDomestic).toBe(false);
    expect(r.guidance).toBe("");
    expect(r.compositeIF).toBeNull();
  });

  it("无核心目录的国际刊 → 不是国内刊", () => {
    const r = buildDomesticJournalGuidance({ catalogs: [], impactFactor: null });
    expect(r.isDomestic).toBe(false);
    expect(buildDomesticJournalGuidance({ catalogs: null, impactFactor: 6.1 }).isDomestic).toBe(false);
  });
});

describe("buildDomesticJournalGuidance — 复合影响因子(#3, 万方/知网口径)", () => {
  it("DB 直查路径字段名 compositeImpactFactor → 注入, 且强制口径标注防混写", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["pku-core"], impactFactor: null, compositeImpactFactor: 1.24 });
    expect(r.compositeIF).toBe(1.24);
    expect(r.guidance).toContain("复合影响因子 1.240");
    expect(r.guidance).toContain("知网/万方口径");
    // 防误导: 明说不许简写成"影响因子 X"/"IF X" 冒充 SCI/JCR 指标
    expect(r.guidance).toMatch(/严禁写成"影响因子 1\.240"/);
  });

  it("collector 路径字段名 compositeIF 同样认", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["cscd"], impactFactor: null, compositeIF: 2.123 });
    expect(r.compositeIF).toBe(2.123);
    expect(r.guidance).toContain("复合影响因子 2.123");
  });

  it("无复合IF → 不出现复合影响因子字样(不诱导编造)", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["pku-core"], impactFactor: null });
    expect(r.compositeIF).toBeNull();
    expect(r.guidance).not.toContain("复合影响因子");
  });
});

describe("buildDomesticJournalGuidance — 禁写清单按 DB 真实字段动态生成(不再自相矛盾)", () => {
  it("DB 有审稿周期 → 指引明说'可如实写', 禁写清单不含审稿天数", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["pku-core"], impactFactor: null, reviewCycle: "3-6个月" });
    expect(r.guidance).toContain("审稿周期 3-6个月");
    expect(r.guidance).toContain("可如实写");
    expect(r.guidance).not.toContain("具体审稿天数");
  });

  it("DB 无审稿周期/录用率 → 两者都进禁写清单", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["pku-core"], impactFactor: null });
    expect(r.guidance).toContain("具体审稿天数");
    expect(r.guidance).toContain("具体录用率百分比");
  });

  it("JCR IF / 中科院分区 / JCR 分区对国内刊恒禁(与 DB 无关)", () => {
    const r = buildDomesticJournalGuidance({ catalogs: ["cssci"], impactFactor: null, reviewCycle: "2个月", acceptanceRate: 0.3 });
    expect(r.guidance).toMatch(/JCR\/SCI 口径的 IF 数字/);
    expect(r.guidance).toMatch(/"X区"\/"中科院X区"\/"JCR Qx"/);
    // 有真实录用率/审稿周期时不反禁
    expect(r.guidance).not.toContain("具体录用率百分比");
    expect(r.guidance).not.toContain("具体审稿天数");
  });
});

describe("generateJournalAIContent 接线(源码结构守卫)", () => {
  it("旧 'N/A' 恒真值判定已清除(两处): isDomesticJournal 与 影响因子 knownFields", async () => {
    const src = await readSrc();
    // 只锁真代码(赋值/分支语句), 注释里引用旧式子讲历史不算
    expect(src).not.toMatch(/const isDomesticJournal\s*=\s*cats\.length\s*>\s*0\s*&&\s*!\(ifText/);
    expect(src).not.toMatch(/if\s*\(ifText && !ifText\.includes\("未知"\)\)\s*knownFields/);
  });

  it("isDomesticJournal / domesticGuidance 均来自纯函数返回值(单一口径)", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const domesticParts = buildDomesticJournalGuidance\(journal\)/);
    expect(src).toMatch(/const isDomesticJournal = domesticParts\.isDomestic/);
    expect(src).toMatch(/const domesticGuidance = domesticParts\.guidance/);
  });

  it("影响因子 knownFields 改判 hasIF; 复合IF 有值时进 ##已知期刊数据## 并带口径警示", async () => {
    const src = await readSrc();
    expect(src).toMatch(/if \(hasIF\) knownFields\.push\(`- 影响因子：\$\{ifText\}`\); else unknownFields\.push\("影响因子"\)/);
    expect(src).toMatch(/复合影响因子（知网\/万方口径/);
    expect(src).toMatch(/严禁简写成"影响因子 \$\{cifText\}"/);
  });

  // 7-28 (③b): 两处的"有中文核心目录"这半条已收口到 journal_kind 单一真相源
  //   (services/journals/journal-kind.ts), 不再各写各的 `cats.length > 0`。
  //   断言随之从"同一句字面量"改为"同一个真相源 + 同一条 !hasIf 叠加" —— 口径统一的要求没变,
  //   变的是它现在由 import 保证, 而不是靠两处手写恰好一样。
  it("与 title-generator 口径统一: 都读 journal_kind(isDomesticKind) 且都叠加 '无真实 IF'", async () => {
    const fs = await import("node:fs/promises");
    const tg = await fs.readFile(new URL("../services/content-engine/title-generator.ts", import.meta.url), "utf8");
    expect(tg).toMatch(/from "\.\.\/journals\/journal-kind\.js"/);
    expect(tg).toMatch(/const isDomestic = isDomesticKind\(toJournalKind\(\{[\s\S]*?\}\)\) && !hasIf/);
    const article = await readSrc();
    expect(article).toMatch(/from "\.\.\/journals\/journal-kind\.js"/);
    expect(article).toMatch(/const isDomestic = isDomesticKind\(toJournalKind\(j\)\) && !hasIF/);
  });
});
