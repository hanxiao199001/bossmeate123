/**
 * 学科同侪集合（A2 第 4 步，8-10）—— 锁「文章能不能写、写出来的数对不对」。
 *
 * 全部脱库：`buildCohortFromRow` 吃一个普通对象，`cohortEligible` / `cohortPromptFacts`
 * 是纯函数。fixture 用**真刊名**，所以这些断言同时也在验证快照匹配确实通了。
 *
 * 四组：
 *   ① 分类只认目录自带的，绝不跟 discipline_code 走
 *   ② 派生量由代码算（LLM 一个数都不许自己推）
 *   ③ 准入四条：无米就不做饭，且每条给出可计数的原因码
 *   ④ 事实清单是数字的唯一出口
 */
import { describe, it, expect } from "vitest";

const {
  buildCohortFromRow,
  cohortEligible,
  cohortPromptFacts,
  cohortMetadata,
  usableSlices,
  MIN_DISCIPLINE_COUNT,
  MAX_SIBLINGS,
} = await import("../services/journals/discipline-cohort.js");

/** 造一个 sparse 国内刊的 DB 行：只有刊名 + 目录，别的全空（154 本实测就是这个样子） */
function row(name: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${name}`,
    name,
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
    ...over,
  };
}

describe("① 分类只认目录自带的", () => {
  /**
   * 🔴 本测试是整个体裁最要命的一条。《武汉体育学院学报》在 `journals.discipline_code`
   * 里是 education，目录自带是「体育学」。跟着 code 走，文章就会写
   * 「同为教育学 CSSCI 的还有《武汉体育学院学报》」—— 读者一眼看穿。
   * 这里刻意把 disciplineCode 设成 education 来施压。
   */
  it("disciplineCode=education 也不能把体育刊写进教育学", () => {
    const c = buildCohortFromRow(row("武汉体育学院学报", { disciplineCode: "education" }));
    const cssci = c.slices.find((s) => s.catalog === "cssci");
    expect(cssci?.disciplineOfThisJournal).toBe("体育学");
    expect(cssci?.countInDiscipline).toBe(12);
    // 事实清单里一次「教育学」都不该出现
    expect(cohortPromptFacts(c).join("\n")).not.toContain("教育学");
  });

  it("同一本刊在两个目录里的分类名不同，各记各的（不合并）", () => {
    const c = buildCohortFromRow(row("武汉体育学院学报", { catalogs: ["cssci", "pku-core"] }));
    const byCat = Object.fromEntries(c.slices.map((s) => [s.catalog, s.disciplineOfThisJournal]));
    expect(byCat).toEqual({ cssci: "体育学", "pku-core": "体育" });
  });

  it("siblings 全部同目录同分类，且不含自己", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    const s = c.slices[0];
    expect(s.siblings.length).toBe(MAX_SIBLINGS);
    expect(s.siblings).not.toContain("中国教育学刊");
    for (const n of s.siblings) {
      const sib = buildCohortFromRow(row(n));
      expect(sib.slices.find((x) => x.catalog === "cssci")?.disciplineOfThisJournal).toBe("教育学");
    }
  });
});

describe("② 派生量由代码算", () => {
  it("43 / 660 = 6.5%，占比由代码给出而非 LLM 推导", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    const s = c.slices[0];
    expect(s.countInDiscipline).toBe(43);
    expect(s.countInCatalogTotal).toBe(660);
    expect(s.shareOfCatalogPct).toBe(6.5);
    expect(cohortPromptFacts(c).join("\n")).toContain("该分类占 6.5%");
  });

  it("版本年逐目录取，不统一（pku-core 是 2023）", () => {
    const c = buildCohortFromRow(row("武汉体育学院学报", { catalogs: ["cssci", "pku-core"] }));
    expect(c.slices.find((s) => s.catalog === "cssci")?.catalogYear).toBe("2023-2024");
    expect(c.slices.find((s) => s.catalog === "pku-core")?.catalogYear).toBe("2023");
  });

  it("每个数字都带版本年限定语（可查证性的一半在这里）", () => {
    const facts = cohortPromptFacts(buildCohortFromRow(row("中国教育学刊")));
    const numeric = facts.filter((f) => /共收录 \d+ 本/.test(f));
    expect(numeric.length).toBeGreaterThan(0);
    for (const f of numeric) expect(f).toMatch(/2023(-2024)? 版/);
  });
});

describe("③ 准入四条：无米不做饭", () => {
  it("正常 sparse 教育刊 → 放行", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    expect(c.supplyLevel).toBe("sparse"); // 确认 fixture 真是 sparse
    expect(cohortEligible(c)).toEqual({ ok: true });
  });

  it("DB 无目录成员资格 → no_catalog_in_db", () => {
    const c = buildCohortFromRow(row("中国教育学刊", { catalogs: [] }));
    expect(cohortEligible(c).reason).toBe("no_catalog_in_db");
  });

  it("快照匹配不上 → snapshot_mismatch（绝不因此降级出稿）", () => {
    const c = buildCohortFromRow(row("某本不存在于任何目录的期刊XYZ"));
    expect(c.matchedBy).toBeNull();
    expect(c.slices).toEqual([]);
    expect(cohortEligible(c).reason).toBe("snapshot_mismatch");
  });

  it("只命中 CSCD → cscd_only（它没有学科分类，撑不起坐标）", () => {
    const c = buildCohortFromRow(row("aBIOTECH", { catalogs: ["cscd"], cscdLevel: "核心库" }));
    expect(c.matchedBy).toBe("name");
    expect(c.slices).toEqual([]);
    expect(c.cscdBadge).toEqual({ level: "核心库", catalogYear: "2023-2024" });
    expect(cohortEligible(c).reason).toBe("cscd_only");
  });

  it("分类只有 1 本 → discipline_too_small（写「共 1 本」没有信息量）", () => {
    // 《中国博物馆》只在北大核心，分类「博物馆事业」全目录仅 1 本
    const c = buildCohortFromRow(row("中国博物馆", { catalogs: ["pku-core"], pkuCoreLevel: "核心" }));
    expect(c.matchedBy).toBe("name");
    expect(c.slices[0].countInDiscipline).toBeLessThan(MIN_DISCIPLINE_COUNT);
    expect(cohortEligible(c).reason).toBe("discipline_too_small");
    // 且过小的切片不进事实清单 —— 免得模板层又把它渲染出来
    expect(usableSlices(c)).toEqual([]);
    expect(cohortPromptFacts(c).join("\n")).not.toContain("博物馆事业");
  });

  it("ISSN 兜底：CSCD 那批无刊名记录仍能匹配上（但仍是 cscd_only）", () => {
    const c = buildCohortFromRow(
      row("本库自己的刊名与CSCD对不上", { catalogs: ["cscd"], cscdLevel: "核心库", issn: "1005-1031" }),
    );
    expect(c.matchedBy).toBe("issn");
    expect(cohortEligible(c).reason).toBe("cscd_only");
  });
});

describe("④ 事实清单是数字的唯一出口", () => {
  it("清单里出现的数字 = 切片里的数字，没有第三处来源", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    const nums = new Set((cohortPromptFacts(c).join("\n").match(/\d+(\.\d+)?/g) ?? []));
    const allowed = new Set<string>();
    for (const s of usableSlices(c)) {
      allowed.add(String(s.countInDiscipline));
      allowed.add(String(s.countInCatalogTotal));
      allowed.add(String(s.shareOfCatalogPct));
      for (const d of s.crossDiscipline) allowed.add(String(d.count));
      // 版本年（2023-2024 会被拆成 2023 与 2024）与清单条数
      for (const p of s.catalogYear.split("-")) allowed.add(p);
      allowed.add(String(s.crossDiscipline.length));
    }
    expect([...nums].filter((n) => !allowed.has(n))).toEqual([]);
  });

  it("siblings 不足 3 本时整块不出现（不凑数）", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    const s = c.slices[0];
    s.siblings = ["《甲》", "《乙》"].slice(0, 2);
    expect(cohortPromptFacts(c).join("\n")).not.toContain("同属");
  });

  it("CSCD 徽章句明令不得据此推学科排名", () => {
    const c = buildCohortFromRow(row("aBIOTECH", { catalogs: ["cscd"], cscdLevel: "核心库" }));
    expect(cohortPromptFacts(c).join("\n")).toContain("不划分学科分类");
  });

  it("metadata 记下版本年与逐切片数字（事后能复核这篇当时用的什么数）", () => {
    const m = cohortMetadata(buildCohortFromRow(row("中国教育学刊"))) as Record<string, unknown>;
    expect(m.cohortMatchedBy).toBe("name");
    expect(m.cohortSnapshotYears).toEqual(["2023-2024"]);
    expect(m.cohortSlices).toEqual([
      expect.objectContaining({ catalog: "cssci", discipline: "教育学", countInDiscipline: 43, shareOfCatalogPct: 6.5 }),
    ]);
  });
});
