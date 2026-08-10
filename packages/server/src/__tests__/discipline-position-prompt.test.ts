/**
 * 「学科定位」prompt（A2 第 5 步，8-10）—— 锁「prompt 有没有在反向教模型编造」。
 *
 * 这里最要紧的不是"禁令写全了没有"，而是**禁的东西有没有从别的块漏进去**。
 * 8-10 就撞到过：原计划复用的钩子库整库绑投稿场景（「录用率接近 40%，IF 还在涨」），
 * 一边禁写 IF 一边拿它当范例 —— 所以有了下面的位置断言。
 */
import { describe, it, expect } from "vitest";

const { buildDisciplinePositionPrompt, GENRE_HOOKS, GENRE_STRUCTURES, GENRE_CLOSINGS, DISCIPLINE_POSITION_JSON_KEYS } =
  await import("../services/content-engine/discipline-position-prompt.js");
const { buildCohortFromRow } = await import("../services/journals/discipline-cohort.js");
const { classifyDataSupply, supplyPromptConstraints } = await import("../services/journals/journal-data-supply.js");
const { pendingCatalogFacts } = await import("../services/journals/catalog-facts.js");

const ROW = {
  id: "j1",
  name: "中国教育学刊",
  nameEn: null,
  issn: null,
  catalogs: ["cssci"],
  impactFactor: null,
  compositeImpactFactor: null,
  partition: null,
  casPartitionNew: null,
  reviewCycle: null,
  acceptanceRate: null,
  cscdLevel: null,
  pkuCoreLevel: null,
  disciplineCode: null,
  publisher: null,
};

function build(seed = 0) {
  const cohort = buildCohortFromRow(ROW);
  return {
    cohort,
    p: buildDisciplinePositionPrompt({ cohort, supply: classifyDataSupply(ROW), variantSeed: seed }),
  };
}

/** 本体裁禁写、但极易被别的块反向示范的词 */
const POISON = ["投稿", "审稿", "录用", "影响因子", "IF", "分区", "版面费", "预警"];

describe("① 禁词只许出现在「严禁书写」块", () => {
  it.each(POISON)("「%s」不出现在禁令块之外的任何一块", (word) => {
    const { p } = build();
    const leaked = Object.entries(p.sections)
      .filter(([k]) => k !== "严禁书写")
      .filter(([, v]) => v.includes(word))
      .map(([k]) => k);
    expect(leaked).toEqual([]);
  });

  it("system 提示词里也不出现禁词", () => {
    const { p } = build();
    for (const w of POISON) expect(p.system).not.toContain(w);
  });

  /**
   * 钩子示例是给模型学句式的，它会连数字一起抄 —— 而「43 本」对下一本刊就是错的。
   * 所以体裁自带的这三组文案里一个阿拉伯数字都不许有。
   */
  it("钩子/结构/结语文案里零阿拉伯数字", () => {
    for (const h of GENRE_HOOKS) {
      expect(h.example).not.toMatch(/\d/);
      expect(h.structure).not.toMatch(/\d/);
    }
    for (const s of [...GENRE_STRUCTURES, ...GENRE_CLOSINGS]) expect(s).not.toMatch(/\d/);
  });
});

describe("② 供给禁令一行不落", () => {
  it("supplyPromptConstraints 的每一行都在禁令块里", () => {
    const { p } = build();
    for (const line of supplyPromptConstraints(classifyDataSupply(ROW))) {
      expect(p.sections["严禁书写"]).toContain(line);
    }
  });

  it("sparse 刊必然带上「无 IF / 无分区 / 无流程数据」三条", () => {
    const lines = supplyPromptConstraints(classifyDataSupply(ROW));
    expect(lines.length).toBeGreaterThanOrEqual(4); // 三条缺失 + sparse 专属那条
  });
});

describe("③ 事实清单是数字的唯一出口", () => {
  it("user 消息里的数字 ⊆ 事实清单里的数字（没有第二处数字来源）", async () => {
    const { cohort, p } = build();
    const { cohortNumberWhitelist } = await import("../services/content-engine/cohort-fact-check.js");
    const white = cohortNumberWhitelist(cohort);
    const factsBlock = p.sections["本篇唯一可用事实"];
    // 事实块以外的所有块
    const others = Object.entries(p.sections)
      .filter(([k]) => k !== "本篇唯一可用事实")
      .map(([, v]) => v)
      .join("\n");
    const stray = [...new Set(others.match(/\d+(?:\.\d+)?/g) ?? [])].filter((n) => !white.has(n));
    /**
     * 允许的例外只有**指令性数字** —— 列表序号、字数区间、标题长度、套话清单条数。
     * 它们描述的是"怎么写"，不是"这本刊是什么"，读者也不会把它们当期刊事实。
     * 🔴 加白名单前先问一句：这个数会不会被模型当成期刊属性抄进正文？会就别加，
     *    改成不带数字的表述（钩子例句就是这么改的）。
     */
    const allowedNoise = new Set([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", // 列表序号
      "800", "1200", // 全文字数区间
      "12", "30", // 标题长度区间
      "20", // 套话清单取前 N 条
    ]);
    expect(stray.filter((n) => !allowedNoise.has(n))).toEqual([]);
    expect(factsBlock).toContain("43");
  });
});

describe("④ 目录说明未审校时整块不出现（不许猜机构名/URL）", () => {
  it("四个目录当前都未审校", () => {
    expect(pendingCatalogFacts().sort()).toEqual(["cscd", "cssci", "cssci-ext", "pku-core", "sci-core"]);
  });

  it("未审校 → 没有「目录说明」块，且全文不出现任何网址", () => {
    const { p } = build();
    expect(p.sections["目录说明(照抄不得改写)"]).toBeUndefined();
    expect(p.user).not.toMatch(/https?:\/\//);
    expect(p.user).not.toMatch(/www\./);
  });
});

describe("⑤ 输出契约与变体", () => {
  it("输出 JSON 块列出全部字段，且不含 rating / submissionAdvice 这类投稿指南语义", () => {
    const { p } = build();
    for (const k of DISCIPLINE_POSITION_JSON_KEYS) expect(p.sections["输出 JSON"]).toContain(`"${k}"`);
    for (const k of ["rating", "submissionAdvice", "ifPrediction"]) {
      expect(p.sections["输出 JSON"]).not.toContain(k);
    }
  });

  it("同一 seed 两次构建逐字相同（把变体随机性与 LLM 随机性分开看）", () => {
    expect(build(2).p.user).toBe(build(2).p.user);
  });

  it("不同 seed 换钩子与结构（防同学科多篇雷同）", () => {
    const a = build(0).p.recipe;
    const b = build(1).p.recipe;
    expect(a.hook).not.toBe(b.hook);
    expect(a.structure).not.toBe(b.structure);
  });

  /** 首轮实测 10 篇里 2 篇把刊名原样当标题返回（4 字），被出稿健康闸判 title_too_short */
  it("明令标题不得只写刊名", () => {
    const { p } = build();
    expect(p.sections["写作要求"]).toContain("标题**不得**只写刊名");
  });

  it("system 明说「清单之外的期刊属性视为不存在」", () => {
    const { p } = build();
    expect(p.system).toContain("视为不存在");
  });
});
