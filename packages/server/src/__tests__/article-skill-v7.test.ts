/**
 * V7（task #11）：article-skill 深度分析升级单测。
 *
 * 覆盖：
 * 1. toPromptIfHistory 双形态适配（V12 enricher / V7 LetPub / null / 不规则）
 * 2. validator 4 新字段交叉校验（已注入 validateNumbersInText 流程）
 *
 * 不测：
 * - generateJournalAIContent 整流程（要 stub LLM provider，且容易烧 token；prompt 拼装
 *   sparse null-skip 已通过单元函数和类型保证）
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {} }));

const { toPromptIfHistory } = await import("../services/data-collection/journal-content-collector.js");
const { validateAIContent } = await import("../services/skills/ai-content-validator.js");

// ============ toPromptIfHistory 单向适配 ============

describe("toPromptIfHistory: V12 enricher → V7 prompt 形态", () => {
  it("V12 enricher shape：data + predicted → V7 history + predicted", () => {
    const v12 = {
      data: [{ year: 2022, if: 4.5 }, { year: 2023, if: 5.1 }, { year: 2024, if: 6.2 }],
      predicted: { year: 2025, if: 7.0, source: "letpub" },
      lastUpdatedAt: "2026-05-02",
    };
    const result = toPromptIfHistory(v12);
    expect(result.history).toEqual([
      { year: 2022, value: 4.5 }, { year: 2023, value: 5.1 }, { year: 2024, value: 6.2 },
    ]);
    expect(result.predicted).toEqual({ year: 2025, value: 7.0, source: "letpub" });
  });

  it("V12 无 predicted → predicted = null", () => {
    const v12 = { data: [{ year: 2024, if: 5.0 }], lastUpdatedAt: "2026-05-02" };
    const result = toPromptIfHistory(v12);
    expect(result.history).toEqual([{ year: 2024, value: 5.0 }]);
    expect(result.predicted).toBeNull();
  });

  it("V7 LetPub shape：直接 array → history 直传，predicted = null", () => {
    const v7 = [{ year: 2023, value: 4.0 }, { year: 2024, value: 4.5 }];
    const result = toPromptIfHistory(v7);
    expect(result.history).toEqual(v7);
    expect(result.predicted).toBeNull();
  });

  it("null / undefined → 空 history + null predicted", () => {
    expect(toPromptIfHistory(null)).toEqual({ history: [], predicted: null });
    expect(toPromptIfHistory(undefined)).toEqual({ history: [], predicted: null });
  });

  it("不规则数据（既无 data 又非 array）→ 空 history（不抛异常）", () => {
    expect(toPromptIfHistory({ foo: "bar" })).toEqual({ history: [], predicted: null });
    expect(toPromptIfHistory("not-an-object")).toEqual({ history: [], predicted: null });
    expect(toPromptIfHistory(42)).toEqual({ history: [], predicted: null });
  });

  it("V12 data 字段缺失 / 非 array → history = []", () => {
    expect(toPromptIfHistory({ data: null }).history).toEqual([]);
    expect(toPromptIfHistory({ data: "broken" } as any).history).toEqual([]);
  });
});

// ============ validator 4 新字段交叉校验 ============

describe("validateAIContent: V7 4 新字段防幻觉", () => {
  const baseJournal: any = {
    name: "Test Journal", nameEn: "TJ", impactFactor: 5.0, acceptanceRate: 0.30,
    discipline: "medicine", partition: "Q2", isWarningList: false,
    publisher: "Test", country: null, website: null, apcFee: null, scopeDescription: null,
  };

  function baseAi(): any {
    return {
      title: "Test", scopeDescription: "", recommendation: "",
      ifPrediction: undefined, rating: 4,
    };
  }

  it("ifHistoryAnalysis 含错 IF → 修正", () => {
    const ai = { ...baseAi(), ifHistoryAnalysis: "<p>近年 IF 高达 12.0，势头猛</p>" };
    const result = validateAIContent(ai, baseJournal);
    expect(result.corrected.ifHistoryAnalysis).toContain("5.0");
    expect(result.issues.find((i) => i.field === "ifHistoryAnalysis")).toBeTruthy();
  });

  it("carRiskAnalysis 含错录用率 → 修正", () => {
    const ai = { ...baseAi(), carRiskAnalysis: "<p>录用率 80%，相对友好</p>" };
    const result = validateAIContent(ai, baseJournal);
    expect(result.corrected.carRiskAnalysis).toContain("30");
    expect(result.issues.find((i) => i.field === "carRiskAnalysis")).toBeTruthy();
  });

  it("scopeAndCitations / submissionAdvice 数值正确 → 0 issue", () => {
    const ai = {
      ...baseAi(),
      scopeAndCitations: "<p>聚焦肿瘤学，IF 5.0 体量稳定</p>",
      submissionAdvice: "<p>录用率 30%，审稿快</p>",
    };
    const result = validateAIContent(ai, baseJournal);
    expect(result.issues.filter((i) => i.field === "scopeAndCitations" || i.field === "submissionAdvice")).toEqual([]);
  });

  it("4 字段全 undefined → 不抛 / 不增 issue", () => {
    const result = validateAIContent(baseAi(), baseJournal);
    const v7Issues = result.issues.filter((i) => /^(ifHistoryAnalysis|carRiskAnalysis|scopeAndCitations|submissionAdvice)$/.test(i.field));
    expect(v7Issues).toEqual([]);
  });
});
