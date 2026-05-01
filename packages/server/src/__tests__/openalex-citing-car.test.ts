/**
 * B.2.2 unit tests
 *  - openalex-fetcher: fetchOpenAlexCitingJournals + fetchOpenAlexCarIndex (fetch mocked, fixture-driven)
 *  - openalex-extractor: extractCitingJournalsTop10 + extractCarIndexHistory + CAR_THRESHOLDS
 *  - fenqubiao-fetcher: parseFenqubiaoMarkdown + cache integration (mocked redis)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "fixtures");

const fixtureCitingAgg = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-citing-aggregate.json"), "utf-8"),
);
const fixtureSelfCite = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-self-cite.json"), "utf-8"),
);
const fixtureCarTotal = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-car-2024-total.json"), "utf-8"),
);
const fixtureCarCN = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-car-2024-cn.json"), "utf-8"),
);
const fixtureTop100Ids = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-top-100-workids.json"), "utf-8"),
);
const fixtureFenqubiao2025 = readFileSync(
  resolve(FIXTURE_DIR, "fenqubiao-warning-2025.md"),
  "utf-8",
);

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    CREDENTIALS_KEY: "test-credentials-key",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    ALLOWED_ORIGINS: "http://localhost:3000",
    OPENALEX_MAILTO: "test@bossmate.com",
    REDIS_URL: "redis://localhost:6379",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

// Mock redis (queue.ts:getRedisConnection) so fenqubiao cache tests don't need real redis
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
vi.mock("../services/task/queue.js", () => ({
  getRedisConnection: () => ({ get: mockRedisGet, set: mockRedisSet }),
}));

const {
  extractCitingJournalsTop10,
  extractCarIndexHistory,
  CAR_THRESHOLDS,
  SELF_CITATION_CONFIDENCE_THRESHOLDS,
} = await import("../services/journal-enricher/extractors/openalex-extractor.js");
const {
  fetchOpenAlexCitingJournals,
  fetchOpenAlexCarIndex,
} = await import("../services/journal-enricher/fetchers/openalex-fetcher.js");
const {
  fetchFenqubiaoWarningList,
  fetchOneYear,
  parseFenqubiaoMarkdown,
} = await import("../services/journal-enricher/fetchers/fenqubiao-fetcher.js");

const LANCET_ID = "https://openalex.org/S49861241";

// ============ extractCitingJournalsTop10 ============

describe("extractCitingJournalsTop10", () => {
  it("maps groups to topJournals + computes selfCitationRate from raw", () => {
    const raw = {
      groups: fixtureCitingAgg.group_by,
      totalCitations: fixtureCitingAgg.meta.count,
      selfCount: fixtureSelfCite.meta.count,
      sampleSize: 100,
    };
    const out = extractCitingJournalsTop10(raw, LANCET_ID);
    expect(out).not.toBeNull();
    expect(out!.topJournals.length).toBeGreaterThan(0);
    expect(out!.topJournals.length).toBeLessThanOrEqual(10);
    // 旧 top-N 路径无 strata → 仍判 low
    expect(out!.selfCitationConfidence).toBe("low");
    // self-rate = selfCount / totalCitations (Lancet ≈ 0.0030)
    expect(out!.selfCitationRate).toBeGreaterThan(0);
    expect(out!.selfCitationRate).toBeLessThan(0.05);
    expect(out!.totalCitations).toBe(fixtureCitingAgg.meta.count);
    // Each topJournal has percent 0-100 integer
    for (const tj of out!.topJournals) {
      if (typeof tj.percent === "number") {
        expect(Number.isInteger(tj.percent)).toBe(true);
        expect(tj.percent).toBeGreaterThanOrEqual(0);
        expect(tj.percent).toBeLessThanOrEqual(100);
      }
    }
  });

  it("filters out the journal itself (avoids self-listing in top 10)", () => {
    const raw = {
      groups: [
        { key: LANCET_ID, key_display_name: "The Lancet", count: 9999 },
        { key: "https://openalex.org/S2", key_display_name: "Other Journal", count: 100 },
      ],
      totalCitations: 1000,
      selfCount: 50,
      sampleSize: 50,
    };
    const out = extractCitingJournalsTop10(raw, LANCET_ID);
    expect(out!.topJournals.length).toBe(1);
    expect(out!.topJournals[0].name).toBe("Other Journal");
  });

  it("returns null on empty groups", () => {
    expect(
      extractCitingJournalsTop10(
        { groups: [], totalCitations: 0, selfCount: 0, sampleSize: 0 },
        LANCET_ID,
      ),
    ).toBeNull();
    expect(extractCitingJournalsTop10(null, LANCET_ID)).toBeNull();
  });

  it("selfCitationRate is undefined when totalCitations=0", () => {
    const out = extractCitingJournalsTop10(
      {
        groups: [{ key: "S2", key_display_name: "X", count: 5 }],
        totalCitations: 0,
        selfCount: 0,
        sampleSize: 1,
      },
      LANCET_ID,
    );
    expect(out!.selfCitationRate).toBeUndefined();
  });

  // ============ task #50 stratified confidence rule ============

  it("confidence='medium' when stratified ≥3 years AND ≥150 samples", () => {
    const out = extractCitingJournalsTop10(
      {
        groups: [{ key: "S2", key_display_name: "X", count: 100 }],
        totalCitations: 1000,
        selfCount: 30,
        sampleSize: 150,
        strataYears: 5,
        strataSampleSizes: [30, 30, 30, 30, 30],
      },
      LANCET_ID,
    );
    expect(out!.selfCitationConfidence).toBe("medium");
  });

  it("confidence='low' when stratified but <3 years (insufficient strata)", () => {
    const out = extractCitingJournalsTop10(
      {
        groups: [{ key: "S2", key_display_name: "X", count: 100 }],
        totalCitations: 500,
        selfCount: 10,
        sampleSize: 200,
        strataYears: 2,
        strataSampleSizes: [100, 100],
      },
      LANCET_ID,
    );
    expect(out!.selfCitationConfidence).toBe("low");
  });

  it("confidence='low' when stratified ≥3 years but total samples <150 (新刊文章稀少)", () => {
    const out = extractCitingJournalsTop10(
      {
        groups: [{ key: "S2", key_display_name: "X", count: 50 }],
        totalCitations: 200,
        selfCount: 5,
        sampleSize: 100,
        strataYears: 5,
        strataSampleSizes: [20, 20, 20, 20, 20],
      },
      LANCET_ID,
    );
    expect(out!.selfCitationConfidence).toBe("low");
  });

  it("SELF_CITATION_CONFIDENCE_THRESHOLDS exposes config knobs", () => {
    expect(SELF_CITATION_CONFIDENCE_THRESHOLDS.mediumMinYears).toBe(3);
    expect(SELF_CITATION_CONFIDENCE_THRESHOLDS.mediumMinSamples).toBe(150);
  });
});

// ============ extractCarIndexHistory ============

describe("extractCarIndexHistory", () => {
  it("computes carIndex per year + ascending sort", () => {
    const raw = [
      { year: 2024, total: 1704, cn: 112 },
      { year: 2020, total: 1675, cn: 92 },
      { year: 2022, total: 1446, cn: 44 },
    ];
    const out = extractCarIndexHistory(raw, null, "0140-6736");
    expect(out!.data.map((r) => r.year)).toEqual([2020, 2022, 2024]);
    expect(out!.data[0].carIndex).toBeCloseTo(0.0549, 3);
    expect(out!.data[2].carIndex).toBeCloseTo(0.0657, 3);
  });

  it("riskLevel = low when latest CAR < threshold low (Lancet 6.57% → mid actually)", () => {
    const raw = [{ year: 2024, total: 1000, cn: 30 }]; // 3% → low
    const out = extractCarIndexHistory(raw, null, "0140-6736");
    expect(out!.riskLevel).toBe("low");
  });

  it("riskLevel = mid when latest CAR in [low, mid)", () => {
    const raw = [{ year: 2024, total: 1000, cn: 100 }]; // 10% → mid
    const out = extractCarIndexHistory(raw, null, "0140-6736");
    expect(out!.riskLevel).toBe("mid");
  });

  it("riskLevel = high when latest CAR >= mid threshold", () => {
    const raw = [{ year: 2024, total: 1000, cn: 250 }]; // 25% → high
    const out = extractCarIndexHistory(raw, null, "0140-6736");
    expect(out!.riskLevel).toBe("high");
  });

  it("fenqubiao 预警命中 → riskLevel='high' 即便 CAR 低", () => {
    const raw = [{ year: 2024, total: 1000, cn: 5 }]; // 0.5% → would be low
    const warningList = new Map([["0140-6736", { latestYear: 2025, reason: "论文工厂" }]]);
    const out = extractCarIndexHistory(raw, warningList, "0140-6736");
    expect(out!.riskLevel).toBe("high");
    expect(out!.isWarningListed).toBe(true);
  });

  it("returns null on empty/null input", () => {
    expect(extractCarIndexHistory(null, null, "0140-6736")).toBeNull();
    expect(extractCarIndexHistory([], null, "0140-6736")).toBeNull();
  });

  it("filters years with total=0 (no papers that year)", () => {
    const raw = [
      { year: 2020, total: 0, cn: 0 },
      { year: 2024, total: 1704, cn: 112 },
    ];
    const out = extractCarIndexHistory(raw, null, "0140-6736");
    expect(out!.data.length).toBe(1);
    expect(out!.data[0].year).toBe(2024);
  });

  it("CAR_THRESHOLDS is exposed for top-of-file config", () => {
    expect(CAR_THRESHOLDS.low).toBe(0.05);
    expect(CAR_THRESHOLDS.mid).toBe(0.15);
  });
});

// ============ fetchOpenAlexCitingJournals (fetch mocked) ============

describe("fetchOpenAlexCitingJournals", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("legacy (stratified=false) with ≤50 IDs runs single-batch (ids → aggregate → self-cite)", async () => {
    // 50 IDs = 1 batch（不触发 batch 拆分）
    const small50Ids = { results: fixtureTop100Ids.results.slice(0, 50) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => small50Ids })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fixtureCitingAgg })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fixtureSelfCite });
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchOpenAlexCitingJournals("S49861241", { stratified: false, sampleSize: 50 });
    expect(out).not.toBeNull();
    expect(out!.groups.length).toBeGreaterThan(0);
    expect(out!.totalCitations).toBe(fixtureCitingAgg.meta.count);
    expect(out!.selfCount).toBe(fixtureSelfCite.meta.count);
    expect(out!.sampleSize).toBe(50);
    expect(out!.strataYears).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed sourceId", async () => {
    const out = await fetchOpenAlexCitingJournals("not-a-source");
    expect(out).toBeNull();
  });

  it("legacy: returns null when ids step has no results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }));
    const out = await fetchOpenAlexCitingJournals("S49861241", { stratified: false });
    expect(out).toBeNull();
  });

  it("legacy: clamps sampleSize to [10, 200]", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => fixtureTop100Ids });
    vi.stubGlobal("fetch", fetchMock);
    await fetchOpenAlexCitingJournals("S49861241", { stratified: false, sampleSize: 5 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("per_page=10"); // clamped up to 10
  });

  // ============ task #50 stratified path ============

  it("stratified (default) fires N year queries + batch-aggregates 150 IDs across batches", async () => {
    // 5 strata × 30 IDs = 150 IDs → 3 cites batches (50/each) → 6 agg+self queries
    const stratumIds = (year: number, n = 30) => ({
      results: Array.from({ length: n }, (_, i) => ({ id: `https://openalex.org/W${year}${i.toString().padStart(3, "0")}` })),
    });
    const aggResp = { meta: { count: 100 }, group_by: [{ key: "https://openalex.org/S2", key_display_name: "X", count: 50 }] };
    const selfResp = { meta: { count: 5 }, results: [] };

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("from_publication_date")) {
        // 哪一年 stratum — 取 from_publication_date 年份
        const m = url.match(/from_publication_date:(\d{4})/);
        return { ok: true, status: 200, json: async () => stratumIds(Number(m?.[1] ?? 2024)) };
      }
      if (url.includes("group_by")) return { ok: true, status: 200, json: async () => aggResp };
      return { ok: true, status: 200, json: async () => selfResp };
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchOpenAlexCitingJournals("S49861241", { strataYears: 5, perStratum: 30, latestYear: 2024 });
    expect(out).not.toBeNull();
    expect(out!.sampleSize).toBe(150);
    expect(out!.strataYears).toBe(5);
    expect(out!.strataSampleSizes).toEqual([30, 30, 30, 30, 30]);
    // 5 stratum queries + 3 batches × (1 agg + 1 self) = 11
    expect(fetchMock).toHaveBeenCalledTimes(11);
    // 累加：3 batches × selfResp.meta.count(5) = 15
    expect(out!.selfCount).toBe(15);
    expect(out!.totalCitations).toBe(300); // 3 × 100
  });

  it("stratified: returns null when 0 IDs across all strata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }));
    const out = await fetchOpenAlexCitingJournals("S49861241", { strataYears: 3, perStratum: 30 });
    expect(out).toBeNull();
  });
});

// ============ fetchOpenAlexCarIndex ============

describe("fetchOpenAlexCarIndex", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("fetches yearly total + CN counts for N years", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      // alternate total / cn
      const fixture = call % 2 === 1 ? fixtureCarTotal : fixtureCarCN;
      return { ok: true, status: 200, json: async () => fixture };
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchOpenAlexCarIndex("S49861241", { years: 5, latestYear: 2024 });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(5);
    // 5 years × 2 queries each
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // Years should be 2020..2024
    expect(out!.map((r) => r.year)).toEqual([2020, 2021, 2022, 2023, 2024]);
  });

  it("rejects malformed sourceId", async () => {
    expect(await fetchOpenAlexCarIndex("not-a-source")).toBeNull();
  });

  it("clamps years to [1, 10]", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixtureCarTotal,
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchOpenAlexCarIndex("S49861241", { years: 99, latestYear: 2024 });
    expect(out!.length).toBe(10); // clamped to 10
  });
});

// ============ fenqubiao parser ============

describe("parseFenqubiaoMarkdown", () => {
  it("extracts ISSN entries from real 2025 fixture", () => {
    const map = parseFenqubiaoMarkdown(fixtureFenqubiao2025, 2025);
    expect(map.size).toBeGreaterThan(0);
    // 0929-6212 = Wireless Personal Communications, in fixture
    expect(map.has("0929-6212")).toBe(true);
    const entry = map.get("0929-6212")!;
    expect(entry.latestYear).toBe(2025);
    expect(entry.reason).toContain("论文工厂");
  });

  it("handles X-suffixed ISSN (e.g. 1234-567X)", () => {
    const md = `<table><tbody><tr><td>Foo Journal</td><td>1234-567X</td><td>审稿质量</td></tr></tbody></table>`;
    const map = parseFenqubiaoMarkdown(md, 2024);
    expect(map.has("1234-567X")).toBe(true);
  });

  it("returns empty map on no rows", () => {
    expect(parseFenqubiaoMarkdown("# heading only", 2024).size).toBe(0);
  });
});

describe("fetchFenqubiaoWarningList (cache + mocked fetch)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
  });

  it("returns cached map when redis hit", async () => {
    const cached = JSON.stringify([["0929-6212", { latestYear: 2025, reason: "论文工厂" }]]);
    mockRedisGet.mockResolvedValueOnce(cached);
    const map = await fetchFenqubiaoWarningList();
    expect(map.size).toBe(1);
    expect(map.has("0929-6212")).toBe(true);
    // No fetch on cache hit
  });

  it("falls back to fetch all years when cache miss + writes cache", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockRedisSet.mockResolvedValueOnce("OK");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => fixtureFenqubiao2025,
    }));
    const map = await fetchFenqubiaoWarningList();
    expect(map.size).toBeGreaterThan(0);
    expect(mockRedisSet).toHaveBeenCalledOnce();
    expect(mockRedisSet.mock.calls[0][0]).toBe("fenqubiao:warning-list:v1");
    expect(mockRedisSet.mock.calls[0][2]).toBe("EX");
    expect(mockRedisSet.mock.calls[0][3]).toBe(86400);
  });

  it("returns empty Map when all year fetches fail (graceful degrade)", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const map = await fetchFenqubiaoWarningList();
    expect(map.size).toBe(0);
  });
});

describe("fetchOneYear (404 graceful)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns empty Map on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }));
    const map = await fetchOneYear(2022);
    expect(map.size).toBe(0);
  });
});
