/**
 * Track A.1：VideoSkill V7 升级单测。
 *
 * 复用 PR #53 toPromptIfHistory 适配器（已在 article-skill-v7.test.ts 6 case 覆盖）；
 * 本 PR 重点：sparse null-skip + V7 LLM 失败 → fallback 到确定性 6 场景。
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

const { VideoSkill } = await import("../services/skills/video-skill.js");

function makeJournal(overrides: Record<string, unknown> = {}) {
  return {
    id: "j-1", name: "Test Journal", nameEn: "Test", impactFactor: 5.0,
    partition: "Q2", casPartition: "2", casPartitionNew: null,
    reviewCycle: "4-8 周", acceptanceRate: 0.30, selfCitationRate: null,
    citeScore: null, jcrSubjects: null, scopeDescription: null,
    discipline: "medicine", publisher: "Test Pub",
    ifHistory: null, jcrFull: null, publicationStats: null,
    scopeDetails: null, publicationCosts: null, citingJournalsTop10: null,
    carIndexHistory: null,
    ...overrides,
  };
}

function makeProvider(behavior: "succeed" | "fail" | "bad-json") {
  return {
    name: "fake",
    chat: vi.fn(async () => {
      if (behavior === "fail") throw new Error("LLM down");
      if (behavior === "bad-json") return { content: "not json at all" };
      return {
        content: JSON.stringify({
          scenes: [
            { sceneNumber: 1, duration: 7, sceneType: "opening", description: "钩子", voiceoverText: "Lancet IF 从 44 涨到 88.5", keywords: ["lancet", "if"] },
            { sceneNumber: 2, duration: 8, sceneType: "data", description: "CAR 趋势", voiceoverText: "近 5 年 3.17%→6.95%", keywords: [] },
            { sceneNumber: 3, duration: 7, sceneType: "cta", description: "投稿建议", voiceoverText: "APC 6830 USD，5% 录用率", keywords: [] },
          ],
        }),
      };
    }),
  } as any;
}

// ============ V7 sparse null-skip ============

describe("VideoSkill.tryGenerateV7Scenes (private via any-cast)", () => {
  it("8 字段全空 → 返 null（不调 LLM，不浪费 token）", async () => {
    const provider = makeProvider("succeed");
    const skill = new VideoSkill(provider) as any;
    const result = await skill.tryGenerateV7Scenes(makeJournal());
    expect(result).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("仅 ifHistory 非空 → 调 LLM，prompt 仅含 IF line（其他字段 null-skip）", async () => {
    const provider = makeProvider("succeed");
    const skill = new VideoSkill(provider) as any;
    const j = makeJournal({ ifHistory: { data: [{ year: 2024, if: 88.5 }], lastUpdatedAt: "x" } });
    const result = await skill.tryGenerateV7Scenes(j);
    expect(result).toHaveLength(3);
    const promptText = provider.chat.mock.calls[0][0].messages[1].content as string;
    // 用 enrichment 行 prefix（- 起手）避免 output schema 例子里的词触发 false positive
    expect(promptText).toContain("- 近 10 年 IF");
    expect(promptText).not.toContain("- 近 5 年 CAR");
    expect(promptText).not.toContain("- 引用 Top10");
    expect(promptText).not.toContain("- 版面费");
    expect(promptText).not.toContain("- 收稿范围");
    expect(promptText).not.toContain("- JCR：");
  });

  it("LLM 抛错 → 返 null（caller fallback）", async () => {
    const provider = makeProvider("fail");
    const skill = new VideoSkill(provider) as any;
    const j = makeJournal({ ifHistory: { data: [{ year: 2024, if: 5 }], lastUpdatedAt: "x" } });
    expect(await skill.tryGenerateV7Scenes(j)).toBeNull();
  });

  it("LLM 出 bad JSON → 返 null", async () => {
    const provider = makeProvider("bad-json");
    const skill = new VideoSkill(provider) as any;
    const j = makeJournal({ ifHistory: { data: [{ year: 2024, if: 5 }], lastUpdatedAt: "x" } });
    expect(await skill.tryGenerateV7Scenes(j)).toBeNull();
  });

  it("V7 所有 7 字段同时注入 → prompt 含 7 行 + LLM 输出 duration clamp [3,15]", async () => {
    const provider = {
      name: "fake",
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          scenes: [
            { sceneNumber: 1, duration: 1, voiceoverText: "x", keywords: Array(7).fill("k") },
            { sceneNumber: 2, duration: 99, voiceoverText: "y", keywords: [] },
          ],
        }),
      })),
    } as any;
    const skill = new VideoSkill(provider) as any;
    const j = makeJournal({
      ifHistory: { data: [{ year: 2024, if: 88.5 }], lastUpdatedAt: "x" },
      carIndexHistory: { data: [{ year: 2024, carIndex: 0.05 }], riskLevel: "low" },
      citingJournalsTop10: { topJournals: [{ name: "Lancet", count: 200 }] },
      scopeDetails: { categories: [{ title: "肿瘤" }] },
      publicationCosts: { apc: 6830, currency: "USD", openAccess: true, lastUpdatedAt: "x" },
      jcrFull: { wosLevel: "SCIE", isTopJournal: true, lastUpdatedAt: "x" },
      publicationStats: { frequency: "周刊", annualVolumeHistory: [{ year: 2024, count: 1000 }] },
    });
    const result = await skill.tryGenerateV7Scenes(j);
    const promptText = provider.chat.mock.calls[0][0].messages[1].content as string;
    expect(promptText).toContain("- 近 10 年 IF");
    expect(promptText).toContain("- 近 5 年 CAR");
    expect(promptText).toContain("- 引用 Top10");
    expect(promptText).toContain("- 收稿范围");
    expect(promptText).toContain("- 版面费");
    expect(promptText).toContain("- JCR：");
    expect(promptText).toContain("- 发文：");
    expect(promptText).toContain("🚫 严格禁止编造");
    // duration clamp + keywords slice
    expect(result?.[0].duration).toBe(3);
    expect(result?.[1].duration).toBe(15);
    expect(result?.[0].visualElements).toHaveLength(5);
  });
});

describe("VideoSkill.hasEnricherData", () => {
  const skill = new VideoSkill(makeProvider("succeed")) as any;
  it("8 字段全空 → false / 任一非空 → true", () => {
    expect(skill.hasEnricherData(makeJournal())).toBe(false);
    expect(skill.hasEnricherData(makeJournal({ ifHistory: { data: [] } }))).toBe(true);
    expect(skill.hasEnricherData(makeJournal({ publicationCosts: { apc: 100 } }))).toBe(true);
  });
});
