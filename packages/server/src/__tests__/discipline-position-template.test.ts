/**
 * 「学科定位」模板（A2 第 6 步，8-10）—— 红线 #14 的断言先写。
 *
 * 这个模板的验收标准不是"好不好看"，是**缺数据时会不会伪装成有数据**。
 * 所以主要篇幅在：槽位缺了整块消失、兜底词表一个不许出现、正文里的数字
 * 与 cohort 对象逐字一致。
 */
import { describe, it, expect } from "vitest";

const { generateDisciplinePositionHtml } = await import(
  "../services/publisher/adapters/discipline-position-template.js"
);
const { buildCohortFromRow } = await import("../services/journals/discipline-cohort.js");

const N = {
  title: "它在教育学分类里的位置",
  openingHook: "先说结论：这本刊在教育学分类里。",
  positioning: "本刊被收录在该目录的教育学分类下。",
  cohortReading: "这一版目录的分类分布如下。",
  siblingNote: "同一格里还有这些刊。",
  verifySteps: "拿官方目录按分类逐条数即可。",
  closing: "目录会更新，看数据要认版本年。",
};

function cohortOf(name: string, over: Record<string, unknown> = {}) {
  return buildCohortFromRow({
    id: "j1",
    name,
    nameEn: null,
    issn: null,
    catalogs: ["cssci"],
    cscdLevel: null,
    pkuCoreLevel: null,
    disciplineCode: null,
    publisher: null,
    ...over,
  });
}

const html = (name = "中国教育学刊", over = {}) => generateDisciplinePositionHtml(cohortOf(name, over), N);

/** 与 output-health 的 FALLBACK_PHRASE_PATTERNS 同源的词表 */
const FALLBACK_WORDS = ["高影响力", "权威期刊", "知名期刊", "顶级期刊", "优质期刊", "影响因子较高", "排版上线"];

describe("① 红线 #14：缺数据不许伪装成有数据", () => {
  it.each(FALLBACK_WORDS)("输出里不出现兜底词「%s」", (w) => {
    expect(html()).not.toContain(w);
  });

  it("不出现「暂无」「待补充」「—」这类占位标注", () => {
    const h = html();
    for (const w of ["暂无", "待补充", "未知", "N/A", "待定"]) expect(h).not.toContain(w);
  });

  it("全文不出现 IF / 分区 / 创刊年 / 版面费 / 审稿", () => {
    const h = html();
    for (const w of ["影响因子", "IF ", "分区", "Q1", "创刊", "版面费", "审稿", "录用"]) {
      expect(h).not.toContain(w);
    }
  });

  it("不出现任何网址（查证入口未审校）", () => {
    expect(html()).not.toMatch(/https?:\/\/|www\./);
  });
});

describe("② 槽位缺了整块消失", () => {
  it("siblings < 3 → 「同一分类下的其他期刊」整块不出现", () => {
    const c = cohortOf("中国教育学刊");
    c.slices[0].siblings = ["甲刊", "乙刊"];
    const h = generateDisciplinePositionHtml(c, N);
    expect(h).not.toContain("同一分类下的其他期刊");
    expect(h).not.toContain("《甲刊》");
    // 但主料那一章仍在
    expect(h).toContain("它在目录里的位置");
  });

  it("crossDiscipline < 3 → 「分类盘子」整块不出现", () => {
    const c = cohortOf("中国教育学刊");
    c.slices[0].crossDiscipline = [{ discipline: "经济学", count: 76 }];
    expect(generateDisciplinePositionHtml(c, N)).not.toContain("分类盘子");
  });

  it("模型没写 verifySteps → 该章不出现，也不出空 <p>", () => {
    const h = generateDisciplinePositionHtml(cohortOf("中国教育学刊"), { ...N, verifySteps: "" });
    expect(h).not.toContain("这些数字怎么核对");
    expect(h).not.toMatch(/<p[^>]*><\/p>/);
  });

  it("叙述字段被模型返成字符串数组或空值都不炸", () => {
    const c = cohortOf("中国教育学刊");
    expect(() => generateDisciplinePositionHtml(c, { title: "x" })).not.toThrow();
    expect(() =>
      generateDisciplinePositionHtml(c, { title: "x", positioning: ["一段", "两段"] as never }),
    ).not.toThrow();
  });
});

describe("③ 数字逐字来自 cohort", () => {
  it("43 / 660 / 6.5% 原样出现，且带目录名与版本年", () => {
    const h = html();
    expect(h).toContain("43 本");
    expect(h).toContain("660 本");
    expect(h).toContain("6.5%");
    expect(h).toContain("CSSCI（2023-2024 版目录）");
  });

  it("落款恒定标注数据来源与版本年", () => {
    expect(html()).toContain("数据来源：CSSCI 2023-2024 版目录");
    expect(html()).toContain("目录更新后本数会变化");
  });

  it("横向盘子自带归属限定语（防读者/模型串位）", () => {
    expect(html()).toContain("与本刊所属分类无关");
  });

  it("多目录时版本年各自标注，不统一", () => {
    const h = html("武汉体育学院学报", { catalogs: ["cssci", "pku-core"] });
    expect(h).toContain("北大核心（2023 版目录）");
    expect(h).toContain("CSSCI（2023-2024 版目录）");
  });

  it("CSCD 只当徽章，不参与任何计数展示", () => {
    const h = html("aBIOTECH", { catalogs: ["cscd"], cscdLevel: "核心库" });
    expect(h).toContain("CSCD（2023-2024 版）核心库");
    expect(h).not.toContain("它在目录里的位置"); // 无学科切片 → 主料章不出现
  });
});

describe("④ 微信安全", () => {
  it("不使用 flex / transform / class", () => {
    const h = html();
    expect(h).not.toMatch(/display\s*:\s*flex/);
    expect(h).not.toMatch(/transform\s*:/);
    expect(h).not.toMatch(/\sclass=/);
  });

  it("刊名里的尖括号被转义（防注入与排版崩坏）", () => {
    const h = html("测试<script>刊");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("<script>");
  });
});
