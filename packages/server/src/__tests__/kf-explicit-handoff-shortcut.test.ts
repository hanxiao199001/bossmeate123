/**
 * 显式转人工关键词捷径（修 20 题验收 #16：两字"人工"被 LLM 判 chitchat 没转接）。
 * 命中 人工/转人工/人工客服/转接/真人 等 → 确定性 handoff，不进 LLM 分类；
 * 正常业务问句 + 闲聊 + "人工智能"类长句不误伤。
 */
import { describe, it, expect } from "vitest";
import { isExplicitHandoff } from "../services/work-wechat/kf-responder.js";

describe("isExplicitHandoff — 显式转人工捷径", () => {
  it("显式要人工 → true", () => {
    for (const s of ["人工", "转人工", "人工客服", "转接", "找人工", "真人", "我要人工", "请转人工", "人工！", "转人工客服", "人工在吗？"]) {
      expect(isExplicitHandoff(s), s).toBe(true);
    }
  });

  it("正常业务问句 → 不误捷径", () => {
    for (const s of ["多久出结果", "你们怎么收费", "Cancer Cell 影响因子多少", "能保证录用吗", "你们是不是代写", "推荐几本肿瘤期刊"]) {
      expect(isExplicitHandoff(s), s).toBe(false);
    }
  });

  it("#14/#15 闲聊 → 仍不转", () => {
    expect(isExplicitHandoff("你好在吗")).toBe(false);
    expect(isExplicitHandoff("今天天气不错")).toBe(false);
  });

  it("含'人工'的正常长句 → 不误伤", () => {
    // "人工智能" 含"人工"两字, 但既非精确匹配、也不命中 handoff 短语
    for (const s of ["人工智能相关的期刊有哪些", "找人工智能方向的SCI期刊", "有没有做人工神经网络的刊"]) {
      expect(isExplicitHandoff(s), s).toBe(false);
    }
  });

  it("空/纯标点 → false", () => {
    expect(isExplicitHandoff("")).toBe(false);
    expect(isExplicitHandoff("？！。")).toBe(false);
  });
});
