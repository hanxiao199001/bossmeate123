/**
 * FAQ 批量导入纯函数单测（红线 #12：新增测试防回归）。
 * 覆盖：粘贴文本两种格式解析、数组归一化、批内去重。
 */
import { describe, it, expect } from "vitest";
import {
  parseFaqText, normalizeImportItems, dedupWithinBatch, faqDedupKey,
} from "../services/work-wechat/kf-faq-import.js";

describe("parseFaqText — 竖线格式", () => {
  it("每行 问题|答案 → items", () => {
    const { items, errors } = parseFaqText("你们怎么收费？|按套餐，具体咨询顾问\n审稿多久？|一般 1-3 个月");
    expect(errors).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ question: "你们怎么收费？", answer: "按套餐，具体咨询顾问", enabled: true, sort: 0 });
    expect(items[1].question).toBe("审稿多久？");
  });

  it("全角竖线 ｜ 与制表符都识别；答案含 | 只按首个切", () => {
    const { items } = parseFaqText("问题A｜答案A\n问题B\t答案B\n问题C|答案C中含|竖线");
    expect(items).toHaveLength(3);
    expect(items[2].answer).toBe("答案C中含|竖线");
  });

  it("空行跳过；缺分隔符/半边空 → 记 error 不入 items", () => {
    const { items, errors } = parseFaqText("正常问|正常答\n\n只有问题没有分隔符\n|只有答案\n问题但空答|");
    expect(items).toHaveLength(1);
    expect(errors.length).toBe(3);
  });
});

describe("parseFaqText — Q/A 格式", () => {
  it("Q:/A: 成对（含中文问:/答:）", () => {
    const text = "Q: 你们是代写吗？\nA: 不是，我们只做投稿咨询与推荐\n问：数据准不准？\n答：均来自权威源";
    const { items, errors } = parseFaqText(text);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ question: "你们是代写吗？", answer: "不是，我们只做投稿咨询与推荐" });
    expect(items[1].question).toBe("数据准不准？");
  });

  it("答案跨多行累积到下一个 Q", () => {
    const text = "问: 服务流程？\n答: 第一步 咨询\n第二步 匹配期刊\n第三步 投稿指导\n问: 保密吗？\n答: 严格保密";
    const { items } = parseFaqText(text);
    expect(items).toHaveLength(2);
    expect(items[0].answer).toBe("第一步 咨询\n第二步 匹配期刊\n第三步 投稿指导");
  });

  it("有 Q 无 A → 记 error", () => {
    const { items, errors } = parseFaqText("问: 只有问题没答案");
    expect(items).toHaveLength(0);
    expect(errors.length).toBe(1);
  });
});

describe("normalizeImportItems — 数组归一化", () => {
  it("非空校验 + 截断 + 补默认", () => {
    const { items, invalid } = normalizeImportItems([
      { question: " Q1 ", answer: " A1 " },
      { question: "", answer: "无问题" },        // invalid
      { question: "Q3", answer: "" },            // invalid
      { question: "Q4", answer: "A4", enabled: false, sort: 5 },
      "不是对象",                                 // invalid
    ]);
    expect(invalid).toBe(3);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ question: "Q1", answer: "A1", enabled: true, sort: 0 });
    expect(items[1]).toMatchObject({ question: "Q4", enabled: false, sort: 5 });
  });

  it("非数组 → 空", () => {
    expect(normalizeImportItems(null).items).toHaveLength(0);
    expect(normalizeImportItems("x").invalid).toBe(0);
  });
});

describe("dedupWithinBatch + faqDedupKey — 批内去重", () => {
  it("同 question（trim/大小写/空白折叠不敏感）保留首条", () => {
    const raw = normalizeImportItems([
      { question: "你们怎么收费", answer: "答1" },
      { question: " 你们怎么收费 ", answer: "答2（重复，跳过）" },
      { question: "你们  怎么收费", answer: "答3（空白折叠后也重复）" },
      { question: "审稿周期", answer: "答4" },
    ]).items;
    const { items, duplicated } = dedupWithinBatch(raw);
    expect(duplicated).toBe(2);
    expect(items).toHaveLength(2);
    expect(items[0].answer).toBe("答1");
  });

  it("faqDedupKey 归一稳定（去空白 + 小写）", () => {
    expect(faqDedupKey("  Hello  World ")).toBe("helloworld");
    expect(faqDedupKey("收费")).toBe(faqDedupKey(" 收 费 "));
  });
});
