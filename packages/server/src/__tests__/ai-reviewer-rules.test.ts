/**
 * 7-05 ④ AI 审稿员 — 纯函数规则层单测 (入池过滤 / few-shot 构建 / 输出解析 / 日上限)。
 * ai-reviewer-rules.ts 零 DB/env 依赖, 可直接 import。
 */
import { describe, it, expect } from "vitest";
import {
  isEligibleForAiReview,
  buildFewShotBlock,
  parseVerdict,
  isUnderDailyCap,
  decideLiveAction,
  GRAY_ZONE_MIN,
  GRAY_ZONE_MAX,
} from "../services/review/ai-reviewer-rules.js";

describe("isEligibleForAiReview 入池过滤", () => {
  const base = (md: Record<string, unknown>) => ({ status: "needs_review", metadata: md });

  it("六维低分灰区 (60-79) 入池", () => {
    expect(isEligibleForAiReview(base({ sixDimTotal: 72 })).eligible).toBe(true);
    expect(isEligibleForAiReview(base({ sixDimTotal: GRAY_ZONE_MIN })).eligible).toBe(true);
    expect(isEligibleForAiReview(base({ sixDimTotal: GRAY_ZONE_MAX })).eligible).toBe(true);
  });

  it("灰区外分数不入池 (太差留人 / 够线不该在待审)", () => {
    expect(isEligibleForAiReview(base({ sixDimTotal: 59 })).eligible).toBe(false);
    expect(isEligibleForAiReview(base({ sixDimTotal: 80 })).eligible).toBe(false);
    expect(isEligibleForAiReview(base({ sixDimTotal: 0 })).eligible).toBe(false);
  });

  it("红线类待审原因永远不碰 (标题矛盾/数字编造/评分降级/没评上分/废稿)", () => {
    // 7-27 补 quality_check_unavailable(没评上分, 无分数锚) 与 output_unhealthy(健康闸拦下的废稿)
    for (const reason of ["title_body_inconsistent", "title_data_fabricated", "sixdim_degraded", "quality_check_unavailable", "body_fabrication", "output_unhealthy"]) {
      const r = isEligibleForAiReview(base({ sixDimTotal: 70, needsReviewReason: reason }));
      expect(r.eligible).toBe(false);
      expect(r.reason).toContain("红线");
    }
  });

  it("非 needs_review 状态不入池", () => {
    expect(isEligibleForAiReview({ status: "generated", metadata: { sixDimTotal: 70 } }).eligible).toBe(false);
    expect(isEligibleForAiReview({ status: "draft", metadata: { sixDimTotal: 70 } }).eligible).toBe(false);
  });

  it("已有 aiReview 记录不重复审 (幂等)", () => {
    expect(isEligibleForAiReview(base({ sixDimTotal: 70, aiReview: { verdict: "approve" } })).eligible).toBe(false);
  });

  it("无六维总分 (validator 类待审) 不入池", () => {
    expect(isEligibleForAiReview(base({})).eligible).toBe(false);
    expect(isEligibleForAiReview(base({ sixDimTotal: "abc" })).eligible).toBe(false);
    expect(isEligibleForAiReview({ status: "needs_review", metadata: null }).eligible).toBe(false);
  });
});

describe("buildFewShotBlock few-shot 构建", () => {
  it("无样本 → hasSamples=false, block 为空 (调用方须降 confidence)", () => {
    const r = buildFewShotBlock([]);
    expect(r.hasSamples).toBe(false);
    expect(r.block).toBe("");
  });

  it("采用/驳回各取最多 3 条", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      verdict: (i % 2 === 0 ? "accept" : "reject") as "accept" | "reject",
      reason: `理由${i}`,
      sixDimTotal: 70 + i,
      title: `文章${i}`,
    }));
    const r = buildFewShotBlock(samples);
    expect(r.hasSamples).toBe(true);
    expect(r.used).toEqual({ accept: 3, reject: 3 });
    expect(r.block).toContain("采用");
    expect(r.block).toContain("驳回");
  });

  it("含理由样本优先于无理由样本", () => {
    const r = buildFewShotBlock([
      { verdict: "reject", reason: null, title: "无理由A" },
      { verdict: "reject", reason: "数据编造", title: "有理由B" },
      { verdict: "reject", reason: null, title: "无理由C" },
      { verdict: "reject", reason: null, title: "无理由D" },
    ]);
    expect(r.used.reject).toBe(3);
    expect(r.block).toContain("有理由B");
    expect(r.block).toContain("数据编造");
  });

  it("只有单边样本也可用", () => {
    const r = buildFewShotBlock([{ verdict: "accept", reason: "小瑕疵可发", title: "A" }]);
    expect(r.hasSamples).toBe(true);
    expect(r.used).toEqual({ accept: 1, reject: 0 });
  });
});

describe("parseVerdict LLM 输出解析", () => {
  it("标准 JSON 解析", () => {
    const r = parseVerdict('{"verdict": "approve", "confidence": 0.85, "reason": "数据一致, 可发"}');
    expect(r).toEqual({ verdict: "approve", confidence: 0.85, reason: "数据一致, 可发" });
  });

  it("markdown 包裹/前后废话容错", () => {
    const r = parseVerdict('好的, 我的裁决:\n```json\n{"verdict": "reject", "confidence": 0.7, "reason": "空洞"}\n```\n以上');
    expect(r.verdict).toBe("reject");
    expect(r.confidence).toBe(0.7);
  });

  it("解析失败 → unsure/0 (宁可留人)", () => {
    expect(parseVerdict("我觉得可以发").verdict).toBe("unsure");
    expect(parseVerdict("").verdict).toBe("unsure");
    expect(parseVerdict("{broken json").verdict).toBe("unsure");
  });

  it("非法 verdict / confidence 越界收敛", () => {
    expect(parseVerdict('{"verdict": "maybe", "confidence": 0.9, "reason": "x"}').verdict).toBe("unsure");
    expect(parseVerdict('{"verdict": "approve", "confidence": 5, "reason": "x"}').confidence).toBe(1);
    expect(parseVerdict('{"verdict": "approve", "confidence": -1, "reason": "x"}').confidence).toBe(0);
    expect(parseVerdict('{"verdict": "approve", "confidence": "abc", "reason": "x"}').confidence).toBe(0);
  });
});

describe("日上限安全阀 + live 决策", () => {
  it("isUnderDailyCap 边界", () => {
    expect(isUnderDailyCap(0, 10)).toBe(true);
    expect(isUnderDailyCap(9, 10)).toBe(true);
    expect(isUnderDailyCap(10, 10)).toBe(false);
    expect(isUnderDailyCap(0, 0)).toBe(false); // cap=0 = 禁止 live 动作
  });

  it("approve 达阈值 + 未超上限 → approve", () => {
    const r = decideLiveAction({ verdict: "approve", confidence: 0.8, minConfidence: 0.75, underCap: true, hasFewShot: true });
    expect(r.action).toBe("approve");
  });

  it("approve 低于阈值 → hold", () => {
    const r = decideLiveAction({ verdict: "approve", confidence: 0.7, minConfidence: 0.75, underCap: true, hasFewShot: true });
    expect(r.action).toBe("hold");
  });

  it("超日上限 → 一律 hold (只记建议)", () => {
    const r = decideLiveAction({ verdict: "approve", confidence: 0.95, minConfidence: 0.75, underCap: false, hasFewShot: true });
    expect(r.action).toBe("hold");
  });

  it("无 few-shot 锚定 → confidence 压到 0.6, 到不了 0.75 阈值 → hold", () => {
    const r = decideLiveAction({ verdict: "approve", confidence: 0.95, minConfidence: 0.75, underCap: true, hasFewShot: false });
    expect(r.action).toBe("hold");
    expect(r.effectiveConfidence).toBe(0.6);
  });

  it("reject ≥0.5 → reject; <0.5 → hold", () => {
    expect(decideLiveAction({ verdict: "reject", confidence: 0.6, minConfidence: 0.75, underCap: true, hasFewShot: true }).action).toBe("reject");
    expect(decideLiveAction({ verdict: "reject", confidence: 0.4, minConfidence: 0.75, underCap: true, hasFewShot: true }).action).toBe("hold");
  });

  it("unsure 恒 hold", () => {
    expect(decideLiveAction({ verdict: "unsure", confidence: 0.9, minConfidence: 0.75, underCap: true, hasFewShot: true }).action).toBe("hold");
  });
});
