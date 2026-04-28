/**
 * letpub-detail-scraper fetcher-only tests.
 *
 * Scope: 只测 fetcher 层（journalid 提取 + 0-results 检测）。
 * parser 层（parseIFHistory / parseCASPartitions / parseJCRPartitions / parseJCIPartitions
 * / parsePubVolumeHistory）尚未适配 ECharts，留给独立 PR。
 *
 * Fixtures（真实 LetPub 响应抓取于 2026-04-28）：
 *   - letpub-search-zero-results.html: 旧版无效参数触发的 0-results 错误页
 *   - letpub-search-lancet-1result.html: 修正参数后 ISSN 0140-6736 命中 1 条 (Lancet, journalid=5528)
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const {
  isZeroResultsSearchPage,
  extractJournalIdFromSearchHtml,
  applySingleRowLowValueIfHistoryGuard,
  buildLetPubSearchFormData,
} = await import(
  "../services/crawler/letpub-detail-scraper.js"
);

const fixturesDir = join(__dirname, "fixtures");
const zeroResultsHtml = readFileSync(join(fixturesDir, "letpub-search-zero-results.html"), "utf-8");
const lancetSearchHtml = readFileSync(join(fixturesDir, "letpub-search-lancet-1result.html"), "utf-8");

describe("isZeroResultsSearchPage", () => {
  it("returns true for the actual 0-results LetPub error page", () => {
    expect(isZeroResultsSearchPage(zeroResultsHtml)).toBe(true);
  });

  it("returns false for a real Lancet 1-result search page", () => {
    expect(isZeroResultsSearchPage(lancetSearchHtml)).toBe(false);
  });

  it("returns true for synthetic minimal '0条记录' marker", () => {
    expect(isZeroResultsSearchPage("<p>搜索条件匹配：0条记录！</p>")).toBe(true);
  });

  it("returns true for synthetic minimal '暂无匹配结果' marker", () => {
    expect(isZeroResultsSearchPage("<div>暂无匹配结果，请确认...</div>")).toBe(true);
  });

  it("returns false for benign HTML without these markers", () => {
    expect(isZeroResultsSearchPage("<html><body>foo</body></html>")).toBe(false);
  });
});

describe("extractJournalIdFromSearchHtml", () => {
  it("extracts journalid=5528 from the real Lancet search HTML", () => {
    expect(extractJournalIdFromSearchHtml(lancetSearchHtml)).toBe("5528");
  });

  it("returns null when search HTML has no journal record (only journalid=0 or none)", () => {
    expect(extractJournalIdFromSearchHtml(zeroResultsHtml)).toBeNull();
  });

  it("ignores journalid=0 and picks first non-zero numeric ID", () => {
    const html = `
      template: <a href="?journalid=0&page=journalapp">stub</a>
      result: <a href="?journalid=12345&page=journalapp">real</a>
    `;
    expect(extractJournalIdFromSearchHtml(html)).toBe("12345");
  });

  it("tolerates URL parameter order variations (journalid first vs last)", () => {
    const order1 = `<a href="./index.php?journalid=8888&page=journalapp&view=detail">A</a>`;
    const order2 = `<a href="./index.php?page=journalapp&view=detail&journalid=9999">B</a>`;
    expect(extractJournalIdFromSearchHtml(order1)).toBe("8888");
    expect(extractJournalIdFromSearchHtml(order2)).toBe("9999");
  });

  it("returns null when no journalid pattern exists at all", () => {
    expect(extractJournalIdFromSearchHtml("<html>no journals here</html>")).toBeNull();
  });
});

// ============ applySingleRowLowValueIfHistoryGuard (orchestrator FP guard) ============
// Temporary guard against parseIFHistory Strategy 3 false positive matching citation
// dates ("2020-04") in real detail HTML. Removable after PR #27 parser rewrite.

describe("applySingleRowLowValueIfHistoryGuard", () => {
  it("discards single-row low-value FP (the '2020-04' citation date case)", () => {
    // Reproduces the exact stub observed in B.2.1.A live recon for Lancet/Nature/BMJ:
    // parseIFHistory Strategy 3 matches "2020-04" → {year:2020, value:4}
    const fp = [{ year: 2020, value: 4 }];
    expect(applySingleRowLowValueIfHistoryGuard(fp)).toEqual([]);
  });

  it("preserves real well-formed history (10 years, Lancet-like)", () => {
    const real = [
      { year: 2015, value: 44.002 },
      { year: 2016, value: 47.831 },
      { year: 2017, value: 53.254 },
      { year: 2018, value: 59.102 },
      { year: 2019, value: 60.392 },
      { year: 2020, value: 79.321 },
      { year: 2021, value: 202.731 },
      { year: 2022, value: 168.9 },
      { year: 2023, value: 98.4 },
      { year: 2024, value: 88.5 },
    ];
    expect(applySingleRowLowValueIfHistoryGuard(real)).toEqual(real);
  });

  it("preserves single-row HIGH value (e.g. one-year sample of a top journal — value=50, length=1)", () => {
    // Edge: data source might temporarily return only one year. If value is high (≥10),
    // it's almost certainly real, not a citation-date FP. Don't false-discard.
    const single = [{ year: 2024, value: 50 }];
    expect(applySingleRowLowValueIfHistoryGuard(single)).toEqual(single);
  });

  it("preserves length=2 even with low values (boundary — only length===1 triggers guard)", () => {
    // A real low-IF journal could legitimately have 2 data points with values < 10.
    // The guard's invariant is "length === 1" specifically (citation date FP is always 1 row).
    const lowTwo = [
      { year: 2023, value: 4 },
      { year: 2024, value: 5 },
    ];
    expect(applySingleRowLowValueIfHistoryGuard(lowTwo)).toEqual(lowTwo);
  });

  it("preserves empty array unchanged (no FP to filter)", () => {
    expect(applySingleRowLowValueIfHistoryGuard([])).toEqual([]);
  });
});

// ============ buildLetPubSearchFormData (b2.1.a.4 ISSN-only search) ============
// LetPub does AND match on searchname+searchissn. "The Lancet"+0140-6736 → 0 hits
// because LetPub's record is "Lancet" (no The). ISSN is unique, so prefer it.

describe("buildLetPubSearchFormData", () => {
  it("ISSN present: sends only searchissn, blanks searchname (avoids 'The X' AND mismatch)", () => {
    const fd = buildLetPubSearchFormData("The Lancet", "0140-6736");
    expect(fd?.get("searchissn")).toBe("0140-6736");
    expect(fd?.get("searchname")).toBe("");
  });

  it("ISSN absent: sends only searchname (fallback path)", () => {
    const fd = buildLetPubSearchFormData("Some Journal", null);
    expect(fd?.get("searchissn")).toBe("");
    expect(fd?.get("searchname")).toBe("Some Journal");
  });

  it("both null: returns null (caller skips network call)", () => {
    expect(buildLetPubSearchFormData(null, null)).toBeNull();
  });
});
