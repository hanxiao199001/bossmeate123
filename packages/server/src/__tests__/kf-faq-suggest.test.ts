/**
 * 「从历史对话学习」FAQ 建议纯函数单测（红线 #12）。
 * 覆盖：会话消息 → LLM 文本、可提炼判定、LLM 输出 → 候选解析。
 */
import { describe, it, expect } from "vitest";
import {
  formatConversationForLlm, conversationHasHumanAnswer, parseSuggestions, type KfMsgLite,
} from "../services/work-wechat/kf-faq-suggest.js";

const msg = (direction: "in" | "out", content: string, aiAction: string | null = null, msgType = "text"): KfMsgLite =>
  ({ direction, content, aiAction, msgType });

describe("formatConversationForLlm", () => {
  it("只取客户入站 + 人工回复（manual/human_wecom），排除 AI answered/transferred/占位", () => {
    const text = formatConversationForLlm([
      msg("in", "你们加急要多久？"),
      msg("out", "好的，已为您转接人工客服", "transferred"), // AI 转接话术，排除
      msg("out", "加急一般 3 个工作日", "manual"),           // 人工，保留
      msg("in", "[图片]", null, "image"),                    // 非 text，排除
      msg("out", "我们客服在企微答复", "human_wecom"),        // 企微端人工，保留
      msg("out", "AI 自动答的", "answered"),                 // AI 答，排除
    ]);
    expect(text).toBe("客户：你们加急要多久？\n人工客服：加急一般 3 个工作日\n人工客服：我们客服在企微答复");
  });

  it("超 maxChars 从头截断保留最近", () => {
    const long = formatConversationForLlm([msg("in", "问" + "x".repeat(50)), msg("out", "答" + "y".repeat(50), "manual")], 20);
    expect(long.length).toBeLessThanOrEqual(20);
  });
});

describe("conversationHasHumanAnswer", () => {
  it("有客户问 + 有人工答 → true", () => {
    expect(conversationHasHumanAnswer([msg("in", "问"), msg("out", "答", "manual")])).toBe(true);
  });
  it("只有 AI 答（无人工）→ false", () => {
    expect(conversationHasHumanAnswer([msg("in", "问"), msg("out", "AI答", "answered")])).toBe(false);
  });
  it("只有客户问无回复 → false", () => {
    expect(conversationHasHumanAnswer([msg("in", "问1"), msg("in", "问2")])).toBe(false);
  });
});

describe("parseSuggestions", () => {
  it("抠 JSON 数组 → 候选（去空、去重）", () => {
    const raw = '这是建议：[{"question":"加急多久","answer":"3个工作日"},{"question":" 加急多久 ","answer":"重复"},{"question":"","answer":"空问题"},{"question":"保密吗","answer":"严格保密"}]';
    const out = parseSuggestions(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ question: "加急多久", answer: "3个工作日" });
    expect(out[1].question).toBe("保密吗");
  });

  it("```json 围栏也能解析", () => {
    const out = parseSuggestions('```json\n[{"question":"Q","answer":"A"}]\n```');
    expect(out).toHaveLength(1);
  });

  it("坏输出/空 → []", () => {
    expect(parseSuggestions("抱歉我无法提炼")).toEqual([]);
    expect(parseSuggestions("")).toEqual([]);
    expect(parseSuggestions("[坏 JSON")).toEqual([]);
  });
});
