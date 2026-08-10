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
    // 本刊的分类断言里绝不能出现教育学
    expect(c.slices.every((s) => s.disciplineOfThisJournal !== "教育学")).toBe(true);
    const facts = cohortPromptFacts(c).join("\n");
    expect(facts).not.toMatch(/本刊[^\n]*「教育学」/);
    expect(facts).toContain("在该版目录中的分类是「体育学」");
  });

  /**
   * 横向盘子列的是**整个目录的分类全景**，写一本体育刊时里面也会出现「教育学 43 本」。
   * 这是本体裁最容易被 LLM 串位的一处：一旦写成「本刊所在的教育学分类有 43 本」就是假话。
   * 所以归属限定语必须**在事实清单里就钉死**，不能指望 prompt 别处的泛泛禁令。
   */
  it("横向盘子必须自带归属限定语（防 LLM 把别的分类安到本刊头上）", () => {
    const facts = cohortPromptFacts(buildCohortFromRow(row("武汉体育学院学报"))).filter((f) =>
      f.includes("分类全景"),
    );
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f).toContain("与本刊所属分类无关");
      expect(f).toMatch(/本刊所属分类是「.+」，不是上列任何一个/);
    }
  });

  /**
   * 隐含设计决定，锁住免得后人当 bug 改掉：**快照说了算，不是 journals.catalogs 说了算**。
   * 快照就是官方目录本身；catalogs 列是抓取产物，实测偏缺。
   * DB 的目录成员资格只当准入的独立佐证（防撞名），不裁剪输出。
   */
  it("DB catalogs 缺北大核心，快照有 → 照样出北大核心切片", () => {
    const c = buildCohortFromRow(row("武汉体育学院学报", { catalogs: ["cssci"] }));
    expect(c.slices.map((s) => s.catalog).sort()).toEqual(["cssci", "pku-core"]);
  });

  it("同一本刊在两个目录里的分类名不同，各记各的（不合并）", () => {
    const c = buildCohortFromRow(row("武汉体育学院学报"));
    const byCat = Object.fromEntries(c.slices.map((s) => [s.catalog, s.disciplineOfThisJournal]));
    expect(byCat).toEqual({ cssci: "体育学", "pku-core": "体育" });
  });

  /**
   * 8-10 实测撞到：同分类的刊若都取头 8 本，两篇文章的同类刊清单会逐字相同。
   * 改为按刊名做确定性偏移取环形窗口 —— 列的每一本仍真属于该分类，只是换一段窗口。
   */
  it("同分类的两本刊给出不同的 siblings 窗口（但各自可重复）", () => {
    const a = buildCohortFromRow(row("中国教育学刊")).slices[0].siblings;
    const b = buildCohortFromRow(row("教育研究")).slices[0].siblings;
    expect(a).not.toEqual(b);
    // 各自稳定
    expect(buildCohortFromRow(row("中国教育学刊")).slices[0].siblings).toEqual(a);
    // 两边列出来的都真属于教育学
    for (const n of [...a, ...b]) {
      expect(buildCohortFromRow(row(n)).slices.find((x) => x.catalog === "cssci")?.disciplineOfThisJournal).toBe(
        "教育学",
      );
    }
  });

  /**
   * 「还有另外 N 本」是本体裁最自然的句式。不给这个数，模型会自己做减法 ——
   * 8-10 实测《陕西师范大学学报》那篇写出「另外 121 本」「另外 73 本」(122-1 / 74-1)，
   * 两处都被数字闸拦下。它一旦算过一次，下次就会"算"一个没依据的数。
   */
  it("othersInDiscipline 由代码给出，且进事实清单", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    expect(c.slices[0].othersInDiscipline).toBe(42);
    expect(cohortPromptFacts(c).join("\n")).toContain("除本刊外还有 42 本");
  });

  /**
   * 事实清单里**已经有**「该分类占 0.4%」，模型仍自己算了倒数（1987÷8≈250，被闸拦下）。
   * 给了占比不等于堵住算术冲动 —— 它会换一种形态再算。所以最常见的倒数形态也由代码给。
   */
  it("oneInEvery 由代码算出并进事实清单", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    expect(c.slices[0].oneInEvery).toBe(15); // 660 / 43
    expect(cohortPromptFacts(c).join("\n")).toContain("平均每 15 本中有 1 本");
    expect(cohortPromptFacts(c).join("\n")).toContain("不要自行换算");
  });

  it("分类占比过大时 oneInEvery 为 null（「每 1 本有 1 本」是废话）", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    c.slices[0].oneInEvery = null;
    expect(cohortPromptFacts(c).join("\n")).not.toContain("平均每");
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

  /**
   * 与 snapshot_mismatch 是**两种不同的诊断**：这里是"匹配上了，但那个目录没有学科维度"。
   * 8-10 实测：不加载 sci-core 时，700 本 SCI 核心刊被误报成 snapshot_mismatch，
   * 让准入率这个拍板数字失真 —— 诊断错了，拍板依据就错了。
   */
  it("只命中徽章目录 → no_disciplined_catalog（CSCD / SCI 核心都算）", () => {
    const c = buildCohortFromRow(row("aBIOTECH", { catalogs: ["cscd"], cscdLevel: "核心库" }));
    expect(c.matchedBy).toBe("name");
    expect(c.slices).toEqual([]);
    expect(c.badges).toEqual([
      expect.objectContaining({ catalog: "cscd", label: "CSCD", level: "核心库", catalogYear: "2023-2024" }),
    ]);
    expect(cohortEligible(c).reason).toBe("no_disciplined_catalog");
  });

  it("SCI 核心刊不再被误报成「匹配不上」", () => {
    const c = buildCohortFromRow(row("NEURAL REGENERATION RESEARCH", { catalogs: ["sci-core"] }));
    expect(c.matchedBy).toBe("name");
    expect(c.badges.some((b) => b.catalog === "sci-core")).toBe(true);
    expect(cohortEligible(c).reason).toBe("no_disciplined_catalog");
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

  it("ISSN 兜底：CSCD 那批无刊名记录仍能匹配上（但仍是 no_disciplined_catalog）", () => {
    const c = buildCohortFromRow(
      row("本库自己的刊名与CSCD对不上", { catalogs: ["cscd"], cscdLevel: "核心库", issn: "1005-1031" }),
    );
    expect(c.matchedBy).toBe("issn");
    expect(cohortEligible(c).reason).toBe("no_disciplined_catalog");
  });
});

describe("④ 事实清单是数字的唯一出口", () => {
  it("清单里出现的数字 = 切片里的数字，没有第三处来源", () => {
    const c = buildCohortFromRow(row("中国教育学刊"));
    const nums = new Set((cohortPromptFacts(c).join("\n").match(/\d+(\.\d+)?/g) ?? []));
    const allowed = new Set<string>();
    for (const s of usableSlices(c)) {
      allowed.add(String(s.countInDiscipline));
      allowed.add(String(s.othersInDiscipline));
      if (s.oneInEvery !== null) allowed.add(String(s.oneInEvery));
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
