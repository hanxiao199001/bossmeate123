/** B.4: stage 自动推进 — 4 transition × 2 case = 8 unit。 */
import { describe, it, expect } from "vitest";
import { evaluateStageTransition } from "../services/sales/stage-transitions.js";

const base = { intentScore: 50, inboundTurnCount: 1, latestInbound: "" };

describe("evaluateStageTransition", () => {
  describe("new → contacted", () => {
    it("触发：任意 inbound 都推", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "new" });
      expect(r).toMatchObject({ newStage: "contacted", changed: true, reason: "first_response" });
    });
    it("边界：低 intent 也推（first_response 优先）", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "new", intentScore: 0 });
      expect(r.changed).toBe(true);
      expect(r.newStage).toBe("contacted");
    });
  });

  describe("contacted → qualified", () => {
    it("触发：turns=3 + intent=60", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "contacted", inboundTurnCount: 3, intentScore: 60 });
      expect(r).toMatchObject({ newStage: "qualified", changed: true, reason: "qualified_threshold" });
    });
    it("不触发边界：turns=2（差 1）→ 不动", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "contacted", inboundTurnCount: 2, intentScore: 80 });
      expect(r.changed).toBe(false);
      expect(r.newStage).toBe("contacted");
    });
  });

  describe("qualified → negotiating", () => {
    it("触发：intent=80 + 含正向词「投稿」", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "qualified", intentScore: 80, latestInbound: "我准备投稿了" });
      expect(r).toMatchObject({ newStage: "negotiating", changed: true, reason: "negotiating_positive_signal" });
    });
    it("不触发边界：intent=80 但无正向词 → 不动", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "qualified", intentScore: 80, latestInbound: "随便聊聊" });
      expect(r.changed).toBe(false);
      expect(r.newStage).toBe("qualified");
    });
  });

  describe("negotiating / need_human：不再 AI 自动推", () => {
    it("negotiating 即使高 intent + 正向词也不动（销售手动 PATCH）", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "negotiating", intentScore: 95, latestInbound: "OK 投稿" });
      expect(r.changed).toBe(false);
      expect(r.newStage).toBe("negotiating");
    });
    it("need_human（hard guard 后）任何输入都不动", () => {
      const r = evaluateStageTransition({ ...base, currentStage: "need_human", intentScore: 95, latestInbound: "OK" });
      expect(r.changed).toBe(false);
      expect(r.newStage).toBe("need_human");
    });
  });
});
