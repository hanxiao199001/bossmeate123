/**
 * ③ 国内刊解冻 —— journal_kind 四分类 + 分体系可信门槛 (7-28)。
 *
 * 病根(审计结论): 不是"国内刊数据缺失", 是**拿国际刊的尺子量国内刊**。
 *   trust-score 的加分项全是国际源(crossref+20 / doaj+10 / letpub+20), 国内刊的可信度天花板是
 *   "进北大核心或 CSCD 核心库 = 恰好 70", 只在 CSCD 扩展库 = 60, 两个目录都不在 = 50;
 *   而选刊器拿 `confidence >= 70` 当硬门槛 → 88% 国内刊在 SQL 层被挡住
 *   (生产实测 verified 427/3707, 综合性人文社科 0/122, 中国政治 0/43)。
 *
 * 本文件锁三件事:
 *   A. 四分类(尤其**定义裂缝刊**与**骑墙刊**)
 *   B. 分体系门槛: 国内刊按目录成员资格 / 国际刊维持 conf>=70
 *   C. TS 谓词与 SQL 片段同源(信号字段一个不少, 防"改了 TS 忘了 SQL")
 */
import { describe, it, expect } from "vitest";
import {
  CN_CATALOG_TAGS,
  buildCnSignalSql,
  buildCnVerifiedSql,
  buildIntlSignalSql,
  buildVerifiedJournalSql,
  classifyJournalScope,
  isCnVerified,
  isDomesticKind,
  isInternationalKind,
  toJournalKind,
} from "../services/journals/journal-kind.js";
import { isUnverifiedJournal, isVerifiedJournal } from "../services/journals/verification.js";

describe("A. journal_kind 四分类", () => {
  it("intl: 有 IF / JCR 分区 / 中科院分区, 且无任何国内信号", () => {
    expect(toJournalKind({ impactFactor: 4.3 })).toBe("intl");
    expect(toJournalKind({ partition: "Q1" })).toBe("intl");
    expect(toJournalKind({ casPartition: "医学2区" })).toBe("intl");
  });

  it("both = 骑墙刊: 国际指标 + 国内目录同时有(sci-core 标签 + 中文核心)", () => {
    expect(toJournalKind({ impactFactor: 4.3, catalogs: ["pku-core", "sci-core"] })).toBe("both");
    expect(toJournalKind({ partition: "Q2", cscdLevel: "核心库" })).toBe("both");
    // 骑墙刊进国内槽位, **不进**国外槽位(否则中华医学杂志会被当成国外刊推给国外定位的号)
    expect(isDomesticKind("both")).toBe(true);
    expect(isInternationalKind("both")).toBe(false);
  });

  it("cn: 只有国内信号 —— catalogs / CSCD / 北大核心 / catalog_type / CN刊号 / 复合IF", () => {
    expect(toJournalKind({ catalogs: ["cssci"] })).toBe("cn");
    expect(toJournalKind({ cscdLevel: "扩展库" })).toBe("cn");
    expect(toJournalKind({ catalogType: "cstpcd" })).toBe("cn");
    expect(toJournalKind({ cnNumber: "CN 11-1234/R" })).toBe("cn");
    expect(toJournalKind({ compositeImpactFactor: 1.24 })).toBe("cn");
    expect(toJournalKind({ compositeIF: 1.24 })).toBe("cn"); // collector 路径别名
  });

  it("🔴 定义裂缝刊: pku_core_level 有值、catalogs 空、无 IF —— 老口径两边都判它不是, 对任何 scope 不可见", () => {
    const 裂缝刊 = { pkuCoreLevel: "北大核心", catalogs: [], impactFactor: null, partition: null };
    // 老口径(留作对照): domestic = catalogs 非空 → false; international = catalogs 空且有IF/分区 → false
    const 老口径domestic = Array.isArray(裂缝刊.catalogs) && 裂缝刊.catalogs.length > 0;
    const 老口径international =
      (!裂缝刊.catalogs || 裂缝刊.catalogs.length === 0) && (裂缝刊.impactFactor != null || 裂缝刊.partition != null);
    expect(老口径domestic).toBe(false);
    expect(老口径international).toBe(false); // ← 两边都 false = 选刊器永远选不到它
    // 新口径: 落 'cn', 国内槽位可见
    expect(toJournalKind(裂缝刊)).toBe("cn");
    expect(isDomesticKind(toJournalKind(裂缝刊))).toBe(true);
  });

  it("unknown: 什么信号都没有(只有刊名的裸行) → 与改造前一样, 对任何 scope 不可见", () => {
    expect(toJournalKind({})).toBe("unknown");
    expect(toJournalKind({ catalogs: [] })).toBe("unknown");
    expect(toJournalKind({ partition: "  " })).toBe("unknown"); // 空白串不算分区
    expect(isDomesticKind("unknown")).toBe(false);
    expect(isInternationalKind("unknown")).toBe(false);
  });

  it("classifyJournalScope 保留 6-19 的刊名中文兜底(三无数据中文刊仍算国内)", () => {
    expect(classifyJournalScope({ name: "高校应用数学学报" })).toBe("domestic");
    expect(classifyJournalScope({ name: "Some Unknown Journal" })).toBe(null);
    expect(classifyJournalScope({ name: "Nature", impactFactor: 50 })).toBe("international");
    expect(classifyJournalScope({ name: "中华医学杂志", impactFactor: 1.2, catalogs: ["pku-core"] })).toBe("domestic");
  });
});

describe("B. 分体系可信门槛 —— 国内刊看目录成员资格, 不看多源交叉", () => {
  it("国内刊: 北大核心 / CSCD(核心库或扩展库) / CSSCI / CSTPCD 任一 → 已核实(哪怕 conf=50)", () => {
    for (const j of [
      { pkuCoreLevel: "北大核心", confidence: 50 },
      { cscdLevel: "核心库", confidence: 50 },
      { cscdLevel: "扩展库", confidence: 60 }, // 老口径 60 分永远过不了 70 线
      { catalogType: "cssci", confidence: 50 },
      { catalogs: ["cscd"], confidence: null },
      { catalogs: ["cstpcd"], confidence: 50 },
    ]) {
      expect(toJournalKind(j)).toBe("cn");
      expect(isVerifiedJournal(j), JSON.stringify(j)).toBe(true);
      expect(isUnverifiedJournal(j)).toBe(false);
    }
  });

  it("国内刊: 无目录但 CN 刊号 + 主办方齐全 → 实体确认, 算已核实", () => {
    expect(isVerifiedJournal({ cnNumber: "CN 11-1234/R", publisher: "中华医学会", confidence: 50 })).toBe(true);
    // 只有刊号、没主办方 → 实体没确认, 仍未核实
    expect(isVerifiedJournal({ cnNumber: "CN 11-1234/R", publisher: null, confidence: 50 })).toBe(false);
  });

  it("国内刊: 只有复合IF(万方回填)、既无目录也无刊号 → 仍未核实(复合IF只证明它是国内刊, 不证明它权威)", () => {
    const j = { compositeImpactFactor: 1.24, confidence: 50 };
    expect(toJournalKind(j)).toBe("cn");
    expect(isVerifiedJournal(j)).toBe(false);
  });

  it("🔴 单调性: 国内刊那一支是 '目录成员资格 OR 老门槛', 原先 conf>=70 的国内刊一本都不许掉下来", () => {
    // 场景 = batch-worker 的窄投影(只有 confidence/dataSource/复合IF, 看不见 catalogs/cscd/pku):
    //   若国内刊改成"只认目录", 这本原本已核实的刊会被反判未核实 → 内容平白多转人工复核(倒退)。
    const 窄投影已核实国内刊 = { compositeImpactFactor: 1.24, confidence: 80, dataSource: "cn_core_verified" };
    expect(toJournalKind(窄投影已核实国内刊)).toBe("cn");
    expect(isVerifiedJournal(窄投影已核实国内刊)).toBe(true);
    // SQL 侧同样是 OR, 不是替换
    expect(buildVerifiedJournalSql()).toMatch(/journal_kind = 'cn' THEN \([\s\S]*? OR /);
  });

  it("🔴 ai_fabricated 影子刊即便字段填满也判未核实(它的刊号/主办方也是 LLM 编的)", () => {
    const 影子刊 = {
      catalogs: ["pku-core"],
      cnNumber: "CN 11-9999/X",
      publisher: "某某学会",
      dataSource: "ai_fabricated",
      confidence: 30,
    };
    expect(isCnVerified(影子刊)).toBe(false);
    expect(isVerifiedJournal(影子刊)).toBe(false);
  });

  it("国际刊(intl/both/unknown): 门槛维持 conf>=70 且非 legacy_unknown —— 一点没放宽", () => {
    expect(isVerifiedJournal({ impactFactor: 4.3, confidence: 70 })).toBe(true);
    expect(isVerifiedJournal({ impactFactor: 4.3, confidence: 69 })).toBe(false);
    expect(isVerifiedJournal({ impactFactor: 4.3, confidence: null })).toBe(false);
    expect(isVerifiedJournal({ impactFactor: 4.3, confidence: 95, dataSource: "legacy_unknown" })).toBe(false);
    expect(isVerifiedJournal({ confidence: 50, dataSource: "multi_source_verified" })).toBe(false); // unknown 体系
  });

  it("骑墙刊(both)走国际门槛: 它有 IF/分区, 该按 SCI 口径核实, 不能靠中文目录蒙混过线", () => {
    const 骑墙刊 = { impactFactor: 4.3, catalogs: ["pku-core", "sci-core"], confidence: 50 };
    expect(toJournalKind(骑墙刊)).toBe("both");
    expect(isVerifiedJournal(骑墙刊)).toBe(false);
  });
});

describe("C. TS 谓词与 SQL 片段同源(改了一边忘了另一边 = 选刊器与代码判定打架)", () => {
  const CN_COLS = ["catalogs", "cscd_level", "pku_core_level", "catalog_type", "cn_number", "composite_impact_factor"];
  const INTL_COLS = ["impact_factor", "partition", "cas_partition"];

  it("国内信号 SQL 覆盖全部 6 个国内列", () => {
    const s = buildCnSignalSql();
    for (const c of CN_COLS) expect(s, `国内信号 SQL 少了列 ${c}`).toContain(c);
  });

  it("国际信号 SQL 覆盖全部 3 个国际列", () => {
    const s = buildIntlSignalSql();
    for (const c of INTL_COLS) expect(s, `国际信号 SQL 少了列 ${c}`).toContain(c);
  });

  it("国内可信 SQL 覆盖全部目录标签 + 刊号/主办方 + 排除 ai_fabricated", () => {
    const s = buildCnVerifiedSql();
    for (const t of CN_CATALOG_TAGS) expect(s, `国内可信 SQL 少了目录标签 ${t}`).toContain(t);
    expect(s).toContain("cn_number");
    expect(s).toContain("publisher");
    expect(s).toContain("ai_fabricated");
  });

  it("总门槛 SQL 按 journal_kind 分体系(cn 走目录, 其余走 conf>=70)", () => {
    const s = buildVerifiedJournalSql("journals.");
    expect(s).toMatch(/CASE WHEN journals\.journal_kind = 'cn' THEN/);
    expect(s).toContain("coalesce(journals.confidence, 0) >= 70");
    expect(s).toContain("legacy_unknown");
    // join 查询里必须带表名限定(journal_usage 也有同名列, 不限定会 ambiguous)
    expect(s).not.toMatch(/[^.]\bconfidence\b(?!,)/);
  });

  it("SQL 片段全部 coalesce 成真布尔(NULL 会让 NOT/CASE 静默失配)", () => {
    for (const s of [buildCnSignalSql(), buildIntlSignalSql(), buildCnVerifiedSql(), buildVerifiedJournalSql()]) {
      expect(s.startsWith("coalesce(")).toBe(true);
    }
  });
});
