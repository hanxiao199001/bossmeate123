import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    CREDENTIALS_KEY: "test-credentials-key",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

const { extractIfHistory } = await import(
  "../services/journal-enricher/extractors/if-history-extractor.js"
);
const { extractJcrFull } = await import(
  "../services/journal-enricher/extractors/jcr-full-extractor.js"
);
const { extractPublicationStats } = await import(
  "../services/journal-enricher/extractors/publication-stats-extractor.js"
);
const { extractPublicationCosts } = await import(
  "../services/journal-enricher/extractors/publication-costs-extractor.js"
);
const { calculateRecommendationScore } = await import(
  "../services/journal-enricher/score/recommendation-score-calculator.js"
);

// ============ Fixture: LetPubJournalDetail (Lancet shape) ============

const fixtureLetpubLancet = {
  ifHistory: [
    { year: 2020, value: 79.32 },
    { year: 2021, value: 202.731 },
    { year: 2022, value: 168.9 },
    { year: 2023, value: 98.4 },
  ],
  pubVolumeHistory: [
    { year: 2020, count: 2400 },
    { year: 2021, count: 2600 },
    { year: 2022, count: 2750 },
    { year: 2023, count: 2800 },
  ],
  casPartitions: [
    {
      version: "中科院2025年分区",
      publishDate: "2025-3-20",
      majorCategory: "1区 医学",
      subCategories: [{ zone: "1区", subject: "医学" }],
      isTop: true,
      isReview: false,
    },
  ],
  jcrPartitions: [
    { subject: "MEDICINE, GENERAL & INTERNAL", database: "SCIE", zone: "Q1", rank: "2/167" },
  ],
  jciPartitions: [
    { subject: "Clinical Medicine", database: "SCIE", zone: "Q1", rank: "5/300" },
  ],
  coverImageUrl: null,
  websiteBannerUrl: null,
};

// ============ if-history-extractor ============

describe("extractIfHistory", () => {
  it("maps letpub.ifHistory.value → shape.if and sorts ascending by year", () => {
    const out = extractIfHistory(fixtureLetpubLancet as any);
    expect(out).not.toBeNull();
    expect(out!.data.length).toBe(4);
    expect(out!.data[0]).toEqual({ year: 2020, if: 79.32 });
    expect(out!.data[3]).toEqual({ year: 2023, if: 98.4 });
    expect(typeof out!.lastUpdatedAt).toBe("string");
  });

  it("returns null when letpub is null", () => {
    expect(extractIfHistory(null)).toBeNull();
  });

  it("returns null when ifHistory is empty", () => {
    expect(extractIfHistory({ ...fixtureLetpubLancet, ifHistory: [] } as any)).toBeNull();
  });

  it("filters out invalid rows (zero/negative IF or non-number year)", () => {
    const dirty = {
      ...fixtureLetpubLancet,
      ifHistory: [
        { year: 2020, value: 0 },
        { year: 2021, value: -5 },
        { year: 2022, value: 168.9 },
        { year: "bad", value: 100 },
      ],
    };
    const out = extractIfHistory(dirty as any);
    expect(out!.data.length).toBe(1);
    expect(out!.data[0]).toEqual({ year: 2022, if: 168.9 });
  });
});

// ============ jcr-full-extractor ============

describe("extractJcrFull", () => {
  it("maps jcrPartitions/jciPartitions and infers wosLevel from majority database", () => {
    const out = extractJcrFull(fixtureLetpubLancet as any);
    expect(out).not.toBeNull();
    expect(out!.wosLevel).toBe("SCIE");
    expect(out!.jifSubjects).toEqual([
      { subject: "MEDICINE, GENERAL & INTERNAL", zone: "Q1", rank: "2/167", database: "SCIE" },
    ]);
    expect(out!.jciSubjects?.[0].subject).toBe("Clinical Medicine");
    expect(out!.isTopJournal).toBe(true);
    expect(out!.isReviewJournal).toBe(false);
  });

  it("returns null when all dimensions are absent", () => {
    const empty = {
      ifHistory: [], pubVolumeHistory: [], casPartitions: [],
      jcrPartitions: [], jciPartitions: [], coverImageUrl: null, websiteBannerUrl: null,
    };
    expect(extractJcrFull(empty as any)).toBeNull();
  });

  it("isReviewJournal=true when any casPartition has isReview", () => {
    const reviewish = {
      ...fixtureLetpubLancet,
      casPartitions: [{ ...fixtureLetpubLancet.casPartitions[0], isTop: false, isReview: true }],
    };
    const out = extractJcrFull(reviewish as any);
    expect(out!.isReviewJournal).toBe(true);
    expect(out!.isTopJournal).toBe(false);
  });
});

// ============ publication-stats-extractor ============

describe("extractPublicationStats", () => {
  it("merges letpub pubVolumeHistory + journal frequency", () => {
    const out = extractPublicationStats({
      letpub: fixtureLetpubLancet as any,
      journalFrequency: "周刊",
    });
    expect(out).not.toBeNull();
    expect(out!.frequency).toBe("周刊");
    expect(out!.annualVolumeHistory!.length).toBe(4);
    expect(out!.annualVolumeHistory![3]).toEqual({ year: 2023, count: 2800 });
  });

  it("returns null when no frequency AND no volume history", () => {
    const out = extractPublicationStats({ letpub: null, journalFrequency: null });
    expect(out).toBeNull();
  });

  it("frequency only is OK (no letpub data)", () => {
    const out = extractPublicationStats({ letpub: null, journalFrequency: "月刊" });
    expect(out!.frequency).toBe("月刊");
    expect(out!.annualVolumeHistory).toBeUndefined();
  });
});

// ============ publication-costs-extractor ============

describe("extractPublicationCosts", () => {
  it("uses DOAJ APC when has_apc=true with price", () => {
    const doaj = {
      id: "doaj-1",
      bibjson: {
        apc: { has_apc: true, max: [{ price: 2950, currency: "USD" }] },
      },
    };
    const out = extractPublicationCosts({ doaj: doaj as any, journalApcFee: null });
    expect(out!.apc).toBe(2950);
    expect(out!.currency).toBe("USD");
    expect(out!.openAccess).toBe(true);
    expect(out!.source).toBe("doaj");
  });

  it("recognizes Diamond OA (DOAJ has_apc=false)", () => {
    const doaj = {
      id: "diamond-1",
      bibjson: { apc: { has_apc: false } },
    };
    const out = extractPublicationCosts({ doaj: doaj as any, journalApcFee: null });
    expect(out!.apc).toBe(0);
    expect(out!.openAccess).toBe(true);
    expect(out!.source).toBe("doaj");
  });

  it("falls back to journal.apcFee when DOAJ null", () => {
    const out = extractPublicationCosts({ doaj: null, journalApcFee: 2950 });
    expect(out!.apc).toBe(2950);
    expect(out!.source).toBe("journal_apc_field");
    expect(out!.openAccess).toBeUndefined();
  });

  it("returns null when no DOAJ + no apcFee (Lancet's expected NULL state)", () => {
    expect(extractPublicationCosts({ doaj: null, journalApcFee: null })).toBeNull();
    expect(extractPublicationCosts({ doaj: null, journalApcFee: 0 })).toBeNull();
  });
});

// ============ score calculator ============

describe("calculateRecommendationScore", () => {
  it("returns integer between 1 and 5", () => {
    const score = calculateRecommendationScore({});
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(5);
  });

  it("Lancet-like (IF=98, Q1, isTop=true, CAR/APC missing) → 4 (B.2.1.A ceiling without CAR data)", () => {
    // ifScore=5*.3 + qScore=5*.25 + carScore=3(default)*.15 + topScore=5*.15 + costScore=3(default)*.15 = 4.40 → round 4
    const score = calculateRecommendationScore({
      impactFactor: 98.4,
      jcrQuartile: "Q1",
      jcrFull: { isTopJournal: true, lastUpdatedAt: "" } as any,
    });
    expect(score).toBe(4);
  });

  it("Lancet-like + low CAR + low APC → 5 (full data ceiling)", () => {
    const score = calculateRecommendationScore({
      impactFactor: 98.4,
      jcrQuartile: "Q1",
      carRiskLevel: "low",
      jcrFull: { isTopJournal: true, lastUpdatedAt: "" } as any,
      publicationCosts: { apc: 1500, currency: "USD", source: "doaj", lastUpdatedAt: "" },
    });
    expect(score).toBe(5);
  });

  it("Q4 low IF + high APC → low score", () => {
    const score = calculateRecommendationScore({
      impactFactor: 1.2,
      jcrQuartile: "Q4",
      publicationCosts: { apc: 9000, currency: "USD", source: "doaj", lastUpdatedAt: "" },
    });
    expect(score).toBeLessThanOrEqual(2);
  });

  it("clamps weighted result to [1,5] integer", () => {
    // 极端低输入也不应低于 1
    const low = calculateRecommendationScore({ impactFactor: 0, jcrQuartile: "Q4" });
    expect(low).toBeGreaterThanOrEqual(1);
    // 极端高也不超 5
    const high = calculateRecommendationScore({
      impactFactor: 200,
      jcrQuartile: "Q1",
      jcrFull: { isTopJournal: true, lastUpdatedAt: "" } as any,
      publicationCosts: { apc: 100, currency: "USD", source: "doaj", lastUpdatedAt: "" },
    });
    expect(high).toBeLessThanOrEqual(5);
  });

  it("CAR risk affects score", () => {
    const lowRisk = calculateRecommendationScore({
      impactFactor: 5, jcrQuartile: "Q2", carRiskLevel: "low",
    });
    const highRisk = calculateRecommendationScore({
      impactFactor: 5, jcrQuartile: "Q2", carRiskLevel: "high",
    });
    expect(lowRisk).toBeGreaterThan(highRisk);
  });
});
