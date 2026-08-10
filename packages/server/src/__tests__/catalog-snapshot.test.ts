/**
 * 目录快照（A2 第 1 步，8-10）—— 锁「文章里那些数字是否可查证」。
 *
 * 本体裁的全部卖点是：读者拿官方目录能逐条数出来。所以这里锁的不是代码行为，
 * 是**数据边界本身**。任何一条断言变红，都意味着已发布文章里的某个数字失真。
 *
 * 四组：
 *   ① 快照真的加载了 —— 防打包回归（见下方注释，8-10 真踩过）
 *   ② 条数与版本年写死 —— 变了必须人工确认是「更新了目录」而不是「文件坏了」
 *   ③ CSCD 无 discipline，绝不进任何学科统计
 *   ④ 只用目录自带分类，不碰 discipline_code；输出稳定可复核
 */
import { describe, it, expect, beforeEach } from "vitest";

const snap = await import("../services/journals/catalog-snapshot.js");
const {
  getCatalogSnapshot,
  snapshotHealthy,
  lookupByName,
  lookupByIssn,
  catalogDisciplineCounts,
  countInDiscipline,
  countInCatalog,
  siblingsInDiscipline,
  __resetCatalogSnapshot,
} = snap;

beforeEach(() => {
  __resetCatalogSnapshot();
});

describe("① 快照必须真的加载到（打包回归守卫）", () => {
  /**
   * 8-10 实测：`scripts/copy-assets.mjs` 原本只拷 `.txt`，这四个 JSON 根本进不了 `dist/`。
   * 而「读不到文件」与「这本刊不在目录里」在下游是**同一个表现**（lookupByName 返回空），
   * 于是线上会产出「该刊未被任何核心目录收录」——一个和真结论长得一模一样的假结论。
   * 所以这条断言不是形式主义：它是这类静默降级唯一能被测试抓住的地方。
   */
  it("零 loadErrors —— 有错就是文件没进 dist 或格式坏了", () => {
    const h = snapshotHealthy();
    expect(h.errors).toEqual([]);
    expect(h.ok).toBe(true);
  });

  it("四个目录都非空", () => {
    for (const c of ["cssci", "cssci-ext", "pku-core", "cscd", "sci-core"] as const) {
      expect(countInCatalog(c)).toBeGreaterThan(0);
    }
  });
});

describe("② 条数与版本年写死（8-10 实测）", () => {
  it.each([
    ["cssci", 660],
    ["cssci-ext", 249],
    ["pku-core", 1987],
    ["cscd", 1339],
    ["sci-core", 2161],
  ] as const)("%s = %i 条", (c, n) => {
    expect(countInCatalog(c)).toBe(n);
  });

  /**
   * 🔴 CSCD 有 **14 条刊名为空但 ISSN 有效**的记录（另外三个目录零空名）。
   * 一开始按「无刊名就跳过」处理，结果 countInCatalog("cscd") = 1325 ——
   * 等于对这 14 本刊断言「未被 CSCD 收录」。现在按 ISSN 留下来，可查不可漏。
   * 这两条断言分别锁「一条不丢」和「空名不进刊名索引」。
   */
  it("CSCD 那 14 条无刊名记录按 ISSN 保留，一条不丢", () => {
    const list = getCatalogSnapshot().byCatalog.get("cscd") ?? [];
    const nameless = list.filter((e) => !e.name);
    expect(nameless).toHaveLength(14);
    expect(nameless.every((e) => !!e.issn)).toBe(true);
    expect(lookupByIssn("1005-1031").some((e) => e.catalog === "cscd")).toBe(true);
    expect(lookupByIssn("10051031")).toEqual(lookupByIssn("1005-1031")); // 连字符无关
    expect(lookupByIssn(null)).toEqual([]);
  });

  it("刊名与 ISSN 双空的行为 0（真丢了才计 droppedRows）", () => {
    expect(getCatalogSnapshot().droppedRows).toBe(0);
  });

  it("空刊名不进刊名索引（否则 lookupByName 会命中一堆无关条目）", () => {
    expect(getCatalogSnapshot().entriesByNorm.has("")).toBe(false);
  });

  it("CSSCI 教育学 = 43 本 —— 文案主叙事直接引用这个数", () => {
    expect(countInDiscipline("cssci", "教育学")).toBe(43);
  });

  /**
   * 🔴 三个目录的版本年**并不相同**（pku-core 是 2023，其余是 2023-2024）。
   * 曾在实现里写过 `?? "2023-2024"` 默认值 —— 那会让北大核心的数字配上错误的限定语。
   * 版本年必须逐条取自数据，这条断言锁住「不许统一成一个常量」。
   */
  it("版本年逐目录不同，不得统一", () => {
    const s = getCatalogSnapshot();
    const yearOf = (c: Parameters<typeof countInCatalog>[0]) =>
      new Set((s.byCatalog.get(c) ?? []).map((e) => e.catalogYear));
    expect(yearOf("cssci")).toEqual(new Set(["2023-2024"]));
    expect(yearOf("cssci-ext")).toEqual(new Set(["2023-2024"]));
    expect(yearOf("cscd")).toEqual(new Set(["2023-2024"]));
    expect(yearOf("sci-core")).toEqual(new Set(["2023"]));
    expect(yearOf("pku-core")).toEqual(new Set(["2023"])); // ← 刻意不同
  });

  it("没有空版本年（空 = 文案写不出「截至 X 版」限定语）", () => {
    for (const list of getCatalogSnapshot().byCatalog.values()) {
      expect(list.every((e) => e.catalogYear.length > 0)).toBe(true);
    }
  });
});

describe("③ 徽章目录绝不进学科统计（CSCD / SCI 核心都没有 discipline）", () => {
  it("sci-core 也是徽章目录：2161 条 discipline 全空，零学科键", () => {
    const list = getCatalogSnapshot().byCatalog.get("sci-core") ?? [];
    expect(list.length).toBe(2161);
    expect(list.every((e) => e.discipline === null)).toBe(true);
    expect([...getCatalogSnapshot().countsByCatalogDiscipline.keys()].filter((k) => k.startsWith("sci-core|"))).toEqual(
      [],
    );
    expect(catalogDisciplineCounts("sci-core")).toEqual([]);
  });

  it("CSCD 每条的 discipline 恒为 null", () => {
    const list = getCatalogSnapshot().byCatalog.get("cscd") ?? [];
    expect(list.every((e) => e.discipline === null)).toBe(true);
  });

  it("学科计数表里一个 cscd| 开头的键都没有", () => {
    const keys = [...getCatalogSnapshot().countsByCatalogDiscipline.keys()];
    expect(keys.filter((k) => k.startsWith("cscd|"))).toEqual([]);
  });

  it("三个查询接口对 CSCD 一律返回空/0，而不是抛错或返回 undefined 桶", () => {
    expect(catalogDisciplineCounts("cscd")).toEqual([]);
    expect(countInDiscipline("cscd", "教育学")).toBe(0);
    expect(siblingsInDiscipline("cscd", "教育学", "某刊")).toEqual([]);
  });

  it("CSCD 保留 cscdLevel（它只能当徽章用）", () => {
    const list = getCatalogSnapshot().byCatalog.get("cscd") ?? [];
    expect(new Set(list.map((e) => e.cscdLevel))).toEqual(new Set(["核心库", "扩展库"]));
  });
});

describe("④ 只用目录自带分类，不碰 discipline_code", () => {
  /**
   * 这三本是 8-10 挑出来的判别样本：前两本在 `journals.discipline_code` 里都是 education，
   * 目录自带分类却完全不同。文案若写「同为教育学 CSSCI 的还有《武汉体育学院学报》」，
   * 读者一眼看出不对 —— 这条断言就是防这个。
   */
  it.each([
    ["武汉体育学院学报", "体育学"],
    ["档案学通讯", "信息资源管理"],
    ["中国教育学刊", "教育学"],
  ])("《%s》在 CSSCI 的分类 = %s", (name, discipline) => {
    const e = lookupByName(name).find((x) => x.catalog === "cssci");
    expect(e?.discipline).toBe(discipline);
  });

  it("lookupByName 走 normName：书名号/全角/空格都能匹配上", () => {
    for (const v of ["《中国教育学刊》", "中国教育学刊 ", "中 国 教 育 学 刊"]) {
      expect(lookupByName(v).some((e) => e.catalog === "cssci")).toBe(true);
    }
    expect(lookupByName("")).toEqual([]);
    expect(lookupByName("完全不存在的刊名XYZ")).toEqual([]);
  });

  it("同一本刊命中多个目录时全部返回（多目录叠加那一章的料）", () => {
    const hits = lookupByName("武汉体育学院学报");
    expect(hits.length).toBeGreaterThan(1);
    expect(new Set(hits.map((e) => e.catalog)).size).toBe(hits.length); // 每个目录至多一条
  });

  it("siblings 同目录同分类、不含自己、按刊名稳定排序", () => {
    const sibs = siblingsInDiscipline("cssci", "教育学", "中国教育学刊", 8);
    expect(sibs).toHaveLength(8);
    expect(sibs).not.toContain("中国教育学刊");
    // 全部确实属于 CSSCI 教育学
    for (const n of sibs) {
      expect(lookupByName(n).find((e) => e.catalog === "cssci")?.discipline).toBe("教育学");
    }
    expect(siblingsInDiscipline("cssci", "教育学", "中国教育学刊", 8)).toEqual(sibs); // 可重复
  });

  it("分类不存在 → 空，不造桶", () => {
    expect(countInDiscipline("cssci", "根本没有这个分类")).toBe(0);
    expect(siblingsInDiscipline("cssci", null, "x")).toEqual([]);
  });

  it("catalogDisciplineCounts 按本数降序且总数守恒", () => {
    const rows = catalogDisciplineCounts("cssci");
    expect(rows.length).toBe(27);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].count).toBeGreaterThanOrEqual(rows[i].count);
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(660); // 零条漏统计
    expect(rows[0]).toEqual({ discipline: "经济学", count: 76 });
  });

  /**
   * 北大核心的分类粒度细得多（148 个桶 vs CSSCI 的 27）。
   * 这正是「同学科多篇数字段雷同」那个落地风险的主要缓解手段，锁住它。
   */
  it("北大核心分类粒度显著细于 CSSCI（同质化缓解依赖这一点）", () => {
    expect(catalogDisciplineCounts("pku-core").length).toBe(148);
    expect(catalogDisciplineCounts("cssci-ext").length).toBe(27);
  });

  it("输出稳定：重建快照后两次结果逐字相同（同一本刊两次生成给同样的数）", () => {
    const a = JSON.stringify(catalogDisciplineCounts("pku-core"));
    __resetCatalogSnapshot();
    expect(JSON.stringify(catalogDisciplineCounts("pku-core"))).toBe(a);
  });
});
