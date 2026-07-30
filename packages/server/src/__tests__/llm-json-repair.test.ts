import { describe, it, expect } from "vitest";
import { extractJsonObject, parseLlmJson } from "../services/content-engine/llm-json.js";
import { findDegenerateFallbacks } from "../services/ai/model-router.js";

/**
 * LLM JSON 修复 + 假兜底守卫 (7-30)。
 *
 * 病史(7-30 单日生产实测):
 *   28 次 六维评分输出不可解析 → 每次白花一次推理调用重打
 *   12 次 重打后仍失败 → 升级到 qwen-plus
 *    2 次 qwen-plus 也吐坏 JSON → 整篇没评上分(quality_check_unavailable)
 *   历史累计「六维评分输出无 JSON」192 次。
 *
 * 原解析只有 `content.match(/\{[\s\S]*\}/)` + JSON.parse, 对推理型模型不够:
 * v4-pro 输出前跑思维链, reasoning / markdown 围栏 / 中途插话都会混进来;
 * 且那个贪婪正则会把 JSON 之后正文里任何一个 `}` 也吞进来。
 * 实测报错位置分布很散(position 89/140/191/237/941/972/990)= 随机混入非 JSON 内容。
 */

const SIX_DIM = `{"topicHook":{"score":8,"weakestSection":"开头","fixHint":"改钩子","justification":"还行"}}`;

describe("extractJsonObject: 干净输入不加工", () => {
  it("原样合法 JSON → 零修复", () => {
    const r = extractJsonObject(SIX_DIM);
    expect(r.value).toEqual({ topicHook: { score: 8, weakestSection: "开头", fixHint: "改钩子", justification: "还行" } });
    expect(r.repairs).toEqual([]);
  });
});

describe("extractJsonObject: 推理型模型的典型污染", () => {
  it("markdown 围栏", () => {
    const r = extractJsonObject("```json\n" + SIX_DIM + "\n```");
    expect((r.value as any).topicHook.score).toBe(8);
    expect(r.repairs).toContain("strip_fence");
  });

  it("<think> 思考段(段里还有伪 JSON, 不能被当成结果)", () => {
    const raw = `<think>我先想想…{"score": 3, "这是思考里的假JSON": true}</think>\n${SIX_DIM}`;
    const r = extractJsonObject(raw);
    expect((r.value as any).topicHook.score).toBe(8); // 不是思考段里那个 3
    expect(r.repairs).toContain("strip_think");
  });

  it("JSON 前有解释文字", () => {
    const r = extractJsonObject(`好的，我来评分。\n\n${SIX_DIM}`);
    expect((r.value as any).topicHook.score).toBe(8);
  });

  it("JSON **后面**还接着说话 —— 旧的贪婪正则正是死在这", () => {
    const raw = `${SIX_DIM}\n\n以上就是我的评分，如有疑问请告诉我。{备注}`;
    // 旧写法: /\{[\s\S]*\}/ 会一路吞到最后那个 `}` → JSON.parse 必炸
    const greedy = raw.match(/\{[\s\S]*\}/)![0];
    expect(() => JSON.parse(greedy)).toThrow();
    // 新写法靠括号配平
    expect((parseLlmJson(raw) as any).topicHook.score).toBe(8);
  });

  it("尾逗号", () => {
    const r = extractJsonObject(`{"a":{"score":8,},}`);
    expect(r.value).toEqual({ a: { score: 8 } });
    expect(r.repairs).toContain("trailing_comma");
  });

  it("全角引号", () => {
    const r = extractJsonObject(`{“a”: 1}`);
    expect(r.value).toEqual({ a: 1 });
    expect(r.repairs).toContain("fullwidth_quote");
  });

  it("输出被截断(尾部缺右括号) → 退到最后一个能配平的位置", () => {
    const raw = `{"topicHook":{"score":8,"fixHint":"x"},"dataAccuracy":{"score":7,"fixHint":"y"`;
    const r = extractJsonObject(raw);
    expect(r.value).not.toBeNull();
    expect((r.value as any).topicHook.score).toBe(8);
  });

  it("字符串里含大括号不能把配平算错", () => {
    const raw = `{"fixHint":"把 {占位符} 换成真实值","score":9}`;
    expect(parseLlmJson(raw)).toEqual({ fixHint: "把 {占位符} 换成真实值", score: 9 });
  });

  it("字符串里含转义引号", () => {
    const raw = `{"justification":"他说\\"很好\\"，我同意","score":9}`;
    expect((parseLlmJson(raw) as any).score).toBe(9);
  });
});

describe("extractJsonObject: 修不出来就老实认输(绝不猜)", () => {
  it("完全没有 JSON → null", () => {
    expect(parseLlmJson("抱歉，我无法完成该请求。")).toBeNull();
  });
  it("空/undefined → null", () => {
    expect(parseLlmJson("")).toBeNull();
    expect(parseLlmJson(undefined)).toBeNull();
    expect(parseLlmJson(null)).toBeNull();
  });
  it("只有左括号 → null(不能凭空补出对象)", () => {
    expect(parseLlmJson("{")).toBeNull();
  });
});

describe("假兜底守卫", () => {
  it("当前路由表没有未声明的假兜底", () => {
    const issues = findDegenerateFallbacks();
    expect(
      issues,
      "以下路由 primary 与 fallback 解析到同一模型, 主模型一挂即全线停(7-27 质检零产出的根)。\n" +
        "改法: ① fallback 换成另一个厂商的模型; ② 若刻意如此, 在 DEGENERATE_FALLBACK_ALLOWED 声明补偿槽:\n" +
        JSON.stringify(issues, null, 2),
    ).toEqual([]);
  });

  it("quality_check 的退化必须由跨厂商的 quality_check_fast 补偿(不是靠注释)", () => {
    // 这条锁的是"补偿关系真实存在"。若日后有人把 quality_check_fast 也改成 deepseek,
    // findDegenerateFallbacks 会返回 compensator_same_vendor, 上面那条就红。
    const issues = findDegenerateFallbacks();
    expect(issues.filter((i) => i.taskType === "quality_check")).toEqual([]);
  });
});
