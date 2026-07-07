/**
 * FAQ 回复数字有源校验（#10 教训：LLM 借相邻 FAQ 壳编"1个工作日"时效承诺）。
 * 规则：回复里"数字+时长/价格/比例单位"的承诺 token，必须在 FAQ 原文找到同数同单位出处，否则拦截转人工。
 * 同图文线"标题数字必须 DB 有据"哲学：prompt 求它不编，不如校验拦住它编。
 */
import { describe, it, expect } from "vitest";
import { findUnsourcedNumbers } from "../services/work-wechat/kf-responder.js";

const FAQ = [
  "1. 问：怎么开始？\n   答：把方向发我，我先给候选期刊清单和各项硬指标。",
  "2. 问：分区区别？\n   答：JCR（Q1-Q4）按学科四等分；中科院分区（1-4区）金字塔型，1区仅前5%左右。",
  "3. 问：OA 版面费？\n   答：完全 OA 通常收 APC（几百到几千美元不等）。",
  "4. 问：多久出结果？\n   答：一般3个工作日内给出候选清单。",
].join("\n");

describe("findUnsourcedNumbers — FAQ 回复数字有源校验", () => {
  it("编造的'1个工作日'(FAQ无此时效) → 拦下", () => {
    // 相邻 FAQ 只写了"候选期刊清单/硬指标"，没写工作日 → LLM 自己脑补"1个工作日"
    const bad = findUnsourcedNumbers("通常1个工作日内给出候选期刊清单及各项硬指标。", FAQ);
    expect(bad).toContain("1个工作日");
  });

  it("FAQ 原文里有'3个工作日' → 照抄不拦", () => {
    expect(findUnsourcedNumbers("一般3个工作日内出结果。", FAQ)).toEqual([]);
  });

  it("编造价格'500美元'(FAQ 只写'几百到几千美元'无 500) → 拦下", () => {
    expect(findUnsourcedNumbers("这本刊 APC 大概500美元。", FAQ)).toContain("500美元");
  });

  it("引用 FAQ 有据的'5%' → 不拦；分区标签'1区/Q1'不误伤", () => {
    expect(findUnsourcedNumbers("1区仅前5%左右，属 Q1。", FAQ)).toEqual([]);
  });

  it("无任何数字的回复 → 空", () => {
    expect(findUnsourcedNumbers("不是，我们不做代写代投，只提供数据咨询。", FAQ)).toEqual([]);
  });

  it("中文数词编造'三天内' → 也能拦（防用中文数字绕过）", () => {
    expect(findUnsourcedNumbers("三天内给您答复。", FAQ)).toContain("三天");
  });

  it("编造比例'30%'(FAQ 无) → 拦下", () => {
    expect(findUnsourcedNumbers("录用率大概能到30%。", FAQ)).toContain("30%");
  });
});
