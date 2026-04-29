/**
 * B.2.1.B.2 OpenAlex tests
 *  - openalex-fetcher: ISSN guard + URL build + retry behavior (with mocked fetch)
 *  - openalex-extractor: 4 functions vs Lancet real-response fixture
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "fixtures");

const fixtureSource = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-source.json"), "utf-8"),
);
const fixtureInstGlobal = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-institutions-global.json"), "utf-8"),
);
const fixtureInstCN = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "openalex-lancet-institutions-cn.json"), "utf-8"),
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
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

const {
  extractTopInstitutionsFromOpenAlex,
  extractScopeDetailsFromOpenAlex,
  extractPublicationCostsFromOpenAlex,
  extractPublisherFromOpenAlex,
} = await import("../services/journal-enricher/extractors/openalex-extractor.js");
const {
  fetchOpenAlexJournal,
  fetchOpenAlexTopInstitutions,
  issnMatches,
} = await import("../services/journal-enricher/fetchers/openalex-fetcher.js");

// ============ extractTopInstitutionsFromOpenAlex ============

describe("extractTopInstitutionsFromOpenAlex", () => {
  it("maps group_by rows to TopInstitutionRow shape (Lancet global fixture)", () => {
    const out = extractTopInstitutionsFromOpenAlex(fixtureInstGlobal.group_by);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(5);
    // Top 1 should be UCL (5519 papers per fixture)
    expect(out![0]).toEqual({
      name: "University College London",
      paperCount: 5519,
      country: undefined,
    });
    expect(out![4].name).toBe("Guy's Hospital");
  });

  it("attaches country tag when provided", () => {
    const out = extractTopInstitutionsFromOpenAlex(fixtureInstCN.group_by, "cn");
    expect(out!.every((r) => r.country === "CN")).toBe(true);
    expect(out![0].name).toBe("Chinese University of Hong Kong");
  });

  it("returns null on empty / null", () => {
    expect(extractTopInstitutionsFromOpenAlex(null)).toBeNull();
    expect(extractTopInstitutionsFromOpenAlex([])).toBeNull();
  });

  it("filters rows missing display_name", () => {
    const dirty = [
      { key: "I1", key_display_name: "", count: 100 },
      { key: "I2", key_display_name: "Real Lab", count: 50 },
      { key: "I3", key_display_name: "  ", count: 30 },
    ] as any;
    const out = extractTopInstitutionsFromOpenAlex(dirty);
    expect(out!.length).toBe(1);
    expect(out![0].name).toBe("Real Lab");
  });
});

// ============ extractScopeDetailsFromOpenAlex ============

describe("extractScopeDetailsFromOpenAlex", () => {
  it("rolls up topic_share by field into subjectDistribution (Lancet fixture)", () => {
    const out = extractScopeDetailsFromOpenAlex(fixtureSource);
    expect(out).not.toBeNull();
    expect(out!.subjectDistribution).toBeDefined();
    // Should have at least one Health-related field given Lancet's nature
    const subjectNames = out!.subjectDistribution!.map((r) => r.subject);
    expect(subjectNames.length).toBeGreaterThan(0);
    // All percents should be 0-100 integers
    for (const r of out!.subjectDistribution!) {
      expect(Number.isInteger(r.percent)).toBe(true);
      expect(r.percent).toBeGreaterThanOrEqual(0);
      expect(r.percent).toBeLessThanOrEqual(100);
    }
    // Sorted descending
    for (let i = 1; i < out!.subjectDistribution!.length; i++) {
      expect(out!.subjectDistribution![i - 1].percent).toBeGreaterThanOrEqual(
        out!.subjectDistribution![i].percent,
      );
    }
  });

  it("dedups categories by field (avoids raw-topic noise)", () => {
    const out = extractScopeDetailsFromOpenAlex(fixtureSource);
    expect(out!.categories).toBeDefined();
    const titles = out!.categories!.map((c) => c.title);
    // No duplicates
    expect(new Set(titles).size).toBe(titles.length);
    expect(out!.source).toBe("openalex");
  });

  it("returns null on empty source", () => {
    expect(extractScopeDetailsFromOpenAlex(null)).toBeNull();
    expect(extractScopeDetailsFromOpenAlex({ id: "S1", topics: [], topic_share: [] } as any)).toBeNull();
  });

  it("ignores topics without field.display_name", () => {
    const sparse = {
      id: "S1",
      topics: [{ display_name: "T1", count: 10, field: undefined } as any, { display_name: "T2", count: 5, field: { display_name: "Medicine" } }],
      topic_share: [{ value: 0.3, field: { display_name: "Medicine" } }],
    } as any;
    const out = extractScopeDetailsFromOpenAlex(sparse);
    expect(out!.categories!.length).toBe(1);
    expect(out!.categories![0].title).toBe("Medicine");
  });
});

// ============ extractPublicationCostsFromOpenAlex ============

describe("extractPublicationCostsFromOpenAlex", () => {
  it("returns shape from Lancet fixture (apc_usd=6830)", () => {
    const out = extractPublicationCostsFromOpenAlex(fixtureSource);
    expect(out).not.toBeNull();
    expect(out!.apc).toBe(6830);
    expect(out!.currency).toBe("USD");
    expect(out!.openAccess).toBe(false); // Lancet is hybrid, not full OA
    expect(out!.source).toBe("openalex");
  });

  it("returns null when apc_usd is null/0", () => {
    expect(
      extractPublicationCostsFromOpenAlex({ ...fixtureSource, apc_usd: null }),
    ).toBeNull();
    expect(
      extractPublicationCostsFromOpenAlex({ ...fixtureSource, apc_usd: 0 }),
    ).toBeNull();
  });

  it("uses apc_prices currency when present", () => {
    const eur = { ...fixtureSource, apc_usd: 1500, apc_prices: [{ price: 1500, currency: "eur" }] };
    const out = extractPublicationCostsFromOpenAlex(eur);
    expect(out!.currency).toBe("EUR");
  });

  it("returns null on null source", () => {
    expect(extractPublicationCostsFromOpenAlex(null)).toBeNull();
  });
});

// ============ extractPublisherFromOpenAlex ============

describe("extractPublisherFromOpenAlex", () => {
  it("returns Lancet's host_organization_name", () => {
    expect(extractPublisherFromOpenAlex(fixtureSource)).toBe("Elsevier BV");
  });

  it("returns null when missing", () => {
    expect(extractPublisherFromOpenAlex(null)).toBeNull();
    expect(
      extractPublisherFromOpenAlex({ ...fixtureSource, host_organization_name: "" }),
    ).toBeNull();
    expect(
      extractPublisherFromOpenAlex({ ...fixtureSource, host_organization_name: undefined }),
    ).toBeNull();
  });

  it("trims and caps at 200 chars", () => {
    const long = "x".repeat(500);
    const out = extractPublisherFromOpenAlex({ ...fixtureSource, host_organization_name: `  ${long}  ` });
    expect(out!.length).toBe(200);
  });
});

// ============ issnMatches ============

describe("issnMatches (ISSN strict guard)", () => {
  it("matches issn_l", () => {
    expect(issnMatches({ issn_l: "0140-6736" }, "0140-6736")).toBe(true);
  });
  it("matches when in issn[]", () => {
    expect(issnMatches({ issn: ["0140-6736", "1474-547X"] }, "1474-547X")).toBe(true);
  });
  it("rejects mismatch", () => {
    expect(issnMatches({ issn_l: "1234-5678" }, "0140-6736")).toBe(false);
    expect(issnMatches({ issn: ["1111-1111"] }, "2222-2222")).toBe(false);
    expect(issnMatches({}, "0140-6736")).toBe(false);
  });
  it("empty input never matches", () => {
    expect(issnMatches({ issn_l: "0140-6736" }, "")).toBe(false);
    expect(issnMatches({ issn_l: "0140-6736" }, "   ")).toBe(false);
  });
});

// ============ fetchOpenAlexJournal (fetch mocked) ============

describe("fetchOpenAlexJournal", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns matched source on issn_l hit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: "https://openalex.org/S99", display_name: "Other", issn_l: "9999-9999" },
          { id: "https://openalex.org/S49861241", display_name: "The Lancet", issn_l: "0140-6736" },
        ],
      }),
    }));
    const out = await fetchOpenAlexJournal("0140-6736");
    expect(out).not.toBeNull();
    expect(out!.id).toBe("https://openalex.org/S49861241");
  });

  it("returns null when no result matches ISSN strictly (guard fires)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ id: "https://openalex.org/S99", display_name: "Wrong Journal", issn_l: "9999-9999" }],
      }),
    }));
    const out = await fetchOpenAlexJournal("0140-6736");
    expect(out).toBeNull();
  });

  it("returns null when results empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }));
    const out = await fetchOpenAlexJournal("0140-6736");
    expect(out).toBeNull();
  });

  it("returns null on null/empty issn (skip path)", async () => {
    expect(await fetchOpenAlexJournal(null)).toBeNull();
    expect(await fetchOpenAlexJournal("  ")).toBeNull();
  });

  it("does NOT retry 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchOpenAlexJournal("0140-6736");
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 500, text: async () => "boom" };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ id: "https://openalex.org/S49861241", issn_l: "0140-6736" }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchOpenAlexJournal("0140-6736");
    expect(out).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ============ fetchOpenAlexTopInstitutions ============

describe("fetchOpenAlexTopInstitutions", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("rejects malformed sourceId", async () => {
    const out = await fetchOpenAlexTopInstitutions("not-a-source", { limit: 5 });
    expect(out).toBeNull();
  });

  it("returns group_by rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixtureInstGlobal,
    }));
    const out = await fetchOpenAlexTopInstitutions("S49861241", { limit: 5 });
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
    expect(out![0].key_display_name).toBe("University College London");
  });

  it("supports country filter (URL contains country_code:cn)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixtureInstCN,
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchOpenAlexTopInstitutions("S49861241", { country: "CN", limit: 5 });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("country_code%3Acn");
  });

  it("strips full URL prefix from sourceId", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixtureInstGlobal,
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchOpenAlexTopInstitutions("https://openalex.org/S49861241");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("source.id%3AS49861241");
  });
});
