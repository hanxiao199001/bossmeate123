/**
 * Day 4 PR-2: admin v2 4 复杂 jsonb zod sub-schemas 单测。
 *
 * 重点：strict 拦未知 key / array max 50 / 数值-枚举 range guard / required 字段缺失。
 * 不测 happy path（PR-1 已覆盖一致结构），重点 boundary + reject 路径。
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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {} }));
vi.mock("../services/task/queue.js", () => ({ journalEnrichQueue: {} }));
vi.mock("../services/task/enrich-throttle.js", () => ({ shuffleFisherYates: <T>(x: T[]) => x }));

const { __testSchemas } = await import("../routes/journals.js");
const {
  jcrFullSchema,
  publicationStatsSchema,
  citingJournalsTop10Schema,
  carIndexHistorySchema,
  journalPatchSchema,
} = __testSchemas;

const ISO = "2026-05-02T00:00:00Z";

describe("jcrFullSchema", () => {
  it("happy: subject + zone + bool 全填", () => {
    expect(jcrFullSchema.parse({
      wosLevel: "SCIE", isTopJournal: true, isReviewJournal: false,
      jifSubjects: [{ subject: "Oncology", zone: "Q1", rank: "6/98", database: "SCIE" }],
      jciSubjects: [], lastUpdatedAt: ISO,
    })).toBeTruthy();
  });
  it("strict: 未知 key 拒绝", () => {
    expect(() => jcrFullSchema.parse({ wosLevel: "SCIE", lastUpdatedAt: ISO, foo: "bar" } as any)).toThrow();
  });
  it("wosLevel 非 enum → 拒绝", () => {
    expect(() => jcrFullSchema.parse({ wosLevel: "随便", lastUpdatedAt: ISO } as any)).toThrow();
  });
  it("jifSubjects > 50 行 → 拒绝（DoS 防御）", () => {
    const rows = Array.from({ length: 51 }, () => ({ subject: "x" }));
    expect(() => jcrFullSchema.parse({ jifSubjects: rows, lastUpdatedAt: ISO })).toThrow();
  });
  it("subject 空字符串 → 拒绝", () => {
    expect(() => jcrFullSchema.parse({ jifSubjects: [{ subject: "" }], lastUpdatedAt: ISO })).toThrow();
  });
  it("zone 不在 Q1-Q4 → 拒绝", () => {
    expect(() => jcrFullSchema.parse({
      jifSubjects: [{ subject: "x", zone: "Q5" }], lastUpdatedAt: ISO,
    } as any)).toThrow();
  });
});

describe("publicationStatsSchema", () => {
  it("happy: frequency + 双 table", () => {
    expect(publicationStatsSchema.parse({
      frequency: "月刊",
      annualVolumeHistory: [{ year: 2024, count: 500 }],
      topInstitutions: [{ name: "PKU", paperCount: 30, percentile: 95.5, country: "CN" }],
      lastUpdatedAt: ISO,
    })).toBeTruthy();
  });
  it("year 超界 → 拒绝", () => {
    expect(() => publicationStatsSchema.parse({
      annualVolumeHistory: [{ year: 99999, count: 1 }], lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("count 负数 → 拒绝", () => {
    expect(() => publicationStatsSchema.parse({
      annualVolumeHistory: [{ year: 2024, count: -1 }], lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("topInstitutions name 空 → 拒绝", () => {
    expect(() => publicationStatsSchema.parse({
      topInstitutions: [{ name: "" }], lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("percentile > 100 → 拒绝", () => {
    expect(() => publicationStatsSchema.parse({
      topInstitutions: [{ name: "x", percentile: 101 }], lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("strict: 未知 key 拒绝", () => {
    expect(() => publicationStatsSchema.parse({ foo: 1, lastUpdatedAt: ISO } as any)).toThrow();
  });
});

describe("citingJournalsTop10Schema", () => {
  it("happy: topJournals + selfCitationRate", () => {
    expect(citingJournalsTop10Schema.parse({
      topJournals: [{ name: "Lancet", count: 200, percent: 12.5, openAlexId: "S123" }],
      selfCitationRate: 0.08, selfCitationConfidence: "medium", totalCitations: 5000,
      lastUpdatedAt: ISO,
    })).toBeTruthy();
  });
  it("topJournals 必填", () => {
    expect(() => citingJournalsTop10Schema.parse({ lastUpdatedAt: ISO } as any)).toThrow();
  });
  it("selfCitationRate > 1 → 拒绝（0-1 区间）", () => {
    expect(() => citingJournalsTop10Schema.parse({
      topJournals: [], selfCitationRate: 1.5, lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("selfCitationConfidence 非 enum → 拒绝", () => {
    expect(() => citingJournalsTop10Schema.parse({
      topJournals: [], selfCitationConfidence: "very-high", lastUpdatedAt: ISO,
    } as any)).toThrow();
  });
  it("topJournals > 50 → 拒绝", () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ name: `j${i}`, count: 1 }));
    expect(() => citingJournalsTop10Schema.parse({ topJournals: rows, lastUpdatedAt: ISO })).toThrow();
  });
  it("count 必填且 ≥ 0", () => {
    expect(() => citingJournalsTop10Schema.parse({
      topJournals: [{ name: "x" }], lastUpdatedAt: ISO,
    } as any)).toThrow();
  });
});

describe("carIndexHistorySchema", () => {
  it("happy: data + riskLevel + isWarningListed", () => {
    expect(carIndexHistorySchema.parse({
      data: [{ year: 2024, carIndex: 0.85 }],
      riskLevel: "low", isWarningListed: false, lastUpdatedAt: ISO,
    })).toBeTruthy();
  });
  it("riskLevel 必填", () => {
    expect(() => carIndexHistorySchema.parse({
      data: [], lastUpdatedAt: ISO,
    } as any)).toThrow();
  });
  it("riskLevel 非 enum → 拒绝", () => {
    expect(() => carIndexHistorySchema.parse({
      data: [], riskLevel: "extreme", lastUpdatedAt: ISO,
    } as any)).toThrow();
  });
  it("carIndex > 1 → 拒绝（0-1 小数）", () => {
    expect(() => carIndexHistorySchema.parse({
      data: [{ year: 2024, carIndex: 1.5 }], riskLevel: "low", lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("year < 1900 → 拒绝", () => {
    expect(() => carIndexHistorySchema.parse({
      data: [{ year: 1899, carIndex: 0.5 }], riskLevel: "low", lastUpdatedAt: ISO,
    })).toThrow();
  });
  it("data > 50 行 → 拒绝", () => {
    const rows = Array.from({ length: 51 }, () => ({ year: 2024, carIndex: 0.5 }));
    expect(() => carIndexHistorySchema.parse({ data: rows, riskLevel: "low", lastUpdatedAt: ISO })).toThrow();
  });
});

describe("journalPatchSchema integration", () => {
  it("接受 7 jsonb 字段同时 patch", () => {
    expect(journalPatchSchema.parse({
      jcrFull: { wosLevel: "SCIE", lastUpdatedAt: ISO },
      publicationStats: { lastUpdatedAt: ISO },
      citingJournalsTop10: { topJournals: [], lastUpdatedAt: ISO },
      carIndexHistory: { data: [], riskLevel: "low", lastUpdatedAt: ISO },
    })).toBeTruthy();
  });
  it("null 清空字段（admin 清空操作）", () => {
    expect(journalPatchSchema.parse({
      jcrFull: null, carIndexHistory: null,
    })).toEqual({ jcrFull: null, carIndexHistory: null });
  });
  it("strict: jsonb 字段含未知 sub-key 拒绝（防止越权写 metadata.wanfang）", () => {
    expect(() => journalPatchSchema.parse({
      jcrFull: { wosLevel: "SCIE", lastUpdatedAt: ISO, hidden: "x" },
    } as any)).toThrow();
  });
});
