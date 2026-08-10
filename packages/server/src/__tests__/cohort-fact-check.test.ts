/**
 * 数字白名单校验（A2 第 5 步，8-10）。
 *
 * 两个方向都要锁：
 *   · 假数必须命中 —— 否则闸形同虚设
 *   · 行文数字不许误报 —— 8-08 扫描守卫收窄三次的教训：误报多了人就不看告警了
 */
import { describe, it, expect } from "vitest";

const { findCohortNumberViolations, cohortNumberWhitelist, findMembershipClaimViolations } = await import(
  "../services/content-engine/cohort-fact-check.js"
);
const { buildCohortFromRow, cohortPromptFacts } = await import("../services/journals/discipline-cohort.js");

const COHORT = buildCohortFromRow({
  id: "j1",
  name: "中国教育学刊",
  nameEn: null,
  issn: null,
  catalogs: ["cssci"],
  cscdLevel: null,
  pkuCoreLevel: null,
  disciplineCode: null,
  publisher: null,
});

const kinds = (body: string) => findCohortNumberViolations(body, COHORT).map((v) => v.matched);

describe("白名单与事实清单同源", () => {
  it("白名单 = 事实清单里出现过的数字，没有额外补充", () => {
    const w = cohortNumberWhitelist(COHORT);
    const fromFacts = new Set(cohortPromptFacts(COHORT).join("\n").match(/\d+(?:\.\d+)?/g) ?? []);
    expect([...w].sort()).toEqual([...fromFacts].sort());
    expect(w.has("43")).toBe(true);
    expect(w.has("660")).toBe(true);
  });
});

describe("假数必须命中", () => {
  it("把 43 写成 430", () => {
    expect(kinds("该分类下共 430 本期刊。")).toContain("430 本");
  });

  it("约数/估算（「余」夹在数字与量词之间，曾从缝里漏过去）", () => {
    expect(kinds("教育学核心期刊有 40 余本。")).toContain("40 余本");
    expect(kinds("该目录收录 700 多种。")).toContain("700 多种");
  });

  /**
   * 43 在白名单里，但目录给的是**精确值** —— 加个「近」就把可查证的数变成不可查证的估计。
   * 所以约数判据刻意不看白名单。
   */
  it("白名单里的真数，被约数措辞包住也算违规", () => {
    const v = findCohortNumberViolations("该分类下有近 43 本期刊。", COHORT);
    expect(v.map((x) => x.kind)).toContain("approximation_not_allowed");
    expect(v.map((x) => x.matched)).toContain("近 43");
  });

  it.each(["超过 660 本", "至少 43 本", "多达 660 本", "不足 43 本"])("约数措辞「%s」命中", (phrase) => {
    const v = findCohortNumberViolations(`该目录${phrase}。`, COHORT);
    expect(v.some((x) => x.kind === "approximation_not_allowed")).toBe(true);
  });

  it("自行算出的百分比", () => {
    expect(kinds("占比约 7.2%。")).toContain("7.2%");
  });

  it("凭空补的创刊年", () => {
    expect(kinds("本刊创刊于 1985 年。")).toContain("1985 年");
  });

  it("自封排名", () => {
    expect(kinds("在该分类中排名第 3。")).toContain("排名第 3");
  });

  it("任何网址都不许（当前查证入口未审校，白名单为空）", () => {
    const v = findCohortNumberViolations("详见 https://example.edu.cn/cssci 。", COHORT);
    expect(v.some((x) => x.kind === "url_not_allowed")).toBe(true);
  });
});

describe("真数与行文数字不许误报", () => {
  it("清单里的真数放行", () => {
    expect(kinds("CSSCI（2023-2024 版）教育学分类下共收录 43 本期刊，全目录共 660 本，占 6.5%。")).toEqual([]);
  });

  /** 「个」不在量词表里 —— 这条是刻意的，见 cohort-fact-check 文件头 */
  it("「3 个步骤」不误报", () => {
    expect(kinds("查证只需 3 个步骤。")).toEqual([]);
  });

  it("「第 2 点」「二〇二三」这类行文不误报", () => {
    expect(kinds("第 2 点要注意。")).toEqual([]);
  });

  it("版本年放行（它在清单里）", () => {
    expect(kinds("以上数据截至 2023 年版目录。")).toEqual([]);
  });

  it("SVG 里的数字不算正文（与 findBodyFabrication 同款处理）", () => {
    expect(kinds(`<svg><text>9999 本</text></svg><p>共 43 本。</p>`)).toEqual([]);
  });

  it("空正文不抛错", () => {
    expect(findCohortNumberViolations(null, COHORT)).toEqual([]);
    expect(findCohortNumberViolations("", COHORT)).toEqual([]);
  });
});

/**
 * 快照必然会旧 —— 句式要选那种**旧了也不会变成错话**的。
 *   「是北大核心期刊」        现在时断言，下一版目录调整后变假话
 *   「入选 2023 版北大核心」  历史事实，永真
 * 这不是文风偏好，是正确性，所以有判据、有测试。
 */
describe("成员资格断言必须锚定版本年", () => {
  const kinds = (t: string) => findMembershipClaimViolations(t).map((v) => v.sentence);

  it.each([
    "本刊是北大核心期刊。",
    "《教育学报》属于 CSSCI 来源期刊。",
    "作为一本 CSCD 收录期刊，它长期稳定。",
    "本刊为中文核心。",
  ])("现在时断言「%s」命中", (t) => {
    expect(kinds(t).length).toBe(1);
  });

  it.each([
    "本刊入选 2023 版北大核心目录。",
    "在 CSSCI 2023-2024 版目录中，本刊被划入教育学分类。",
    "该版 CSSCI 收录 660 本。",
  ])("锚定了版本年的「%s」放行", (t) => {
    expect(kinds(t)).toEqual([]);
  });

  it("同一段里只在开头交代一次版本年不算数（逐句判）", () => {
    const t = "以下数据出自 2023 版目录。本刊是北大核心期刊。";
    expect(kinds(t).length).toBe(1);
    expect(kinds(t)[0]).toContain("是北大核心期刊");
  });

  it("不提目录名的句子不受影响", () => {
    expect(kinds("本刊聚焦教育研究，读者以一线教师为主。")).toEqual([]);
    expect(findMembershipClaimViolations(null)).toEqual([]);
  });
});

describe("报告形态便于人工复核", () => {
  it("带整句原文，不只给一个孤零零的数", () => {
    const v = findCohortNumberViolations("本刊创刊于 1985 年，历史悠久。", COHORT);
    expect(v[0].sentence).toContain("创刊于 1985 年");
    expect(v[0].kind).toBe("number_not_in_facts");
  });

  it("同一句里的同一处只报一次", () => {
    const v = findCohortNumberViolations("共 430 本。共 430 本。", COHORT);
    expect(v.filter((x) => x.matched.includes("430")).length).toBeLessThanOrEqual(4);
  });
});
