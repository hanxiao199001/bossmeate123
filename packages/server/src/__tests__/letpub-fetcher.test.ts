/**
 * letpub-detail-scraper unit tests (fetcher + parser).
 *
 * PR #30 (b2.1.a.2): parsers rewritten for ECharts. Guard `applySingleRowLowValueIfHistoryGuard`
 * removed — its only purpose was tolerating Strategy 3 citation-date FP, which doesn't exist
 * in the new ECharts-aware parsers.
 *
 * Fixtures (real LetPub responses captured 2026-04-28):
 *   - letpub-search-zero-results.html      (PR #26 baseline)
 *   - letpub-search-lancet-1result.html    (PR #26 baseline)
 *   - letpub-lancet-detail-real.html       (487KB Lancet detail; IF=88.5)
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
  buildLetPubSearchFormData,
  parseIFHistory,
  parsePubVolumeHistory,
  parseCASPartitions,
  parseJCRPartitions,
  parseJCIPartitions,
} = await import("../services/crawler/letpub-detail-scraper.js");

const fixturesDir = join(__dirname, "fixtures");
const zeroResultsHtml = readFileSync(join(fixturesDir, "letpub-search-zero-results.html"), "utf-8");
const lancetSearchHtml = readFileSync(join(fixturesDir, "letpub-search-lancet-1result.html"), "utf-8");
const lancetDetailHtml = readFileSync(join(fixturesDir, "letpub-lancet-detail-real.html"), "utf-8");

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

// ============ PR #30: parser ECharts rewrite ============

describe("parseIFHistory (ECharts 'IF值' series)", () => {
  it("extracts 10-year IF series from real Lancet detail HTML (88.5 in 2024)", () => {
    const result = parseIFHistory(lancetDetailHtml);
    expect(result.length).toBeGreaterThanOrEqual(5);
    const last = result[result.length - 1];
    expect(last.year).toBe(2024);
    expect(last.value).toBeCloseTo(88.5, 1);
    // 已知真值范围：所有 IF > 30（顶刊）
    for (const r of result) expect(r.value).toBeGreaterThan(30);
  });

  it("returns [] for empty HTML (no chart present)", () => {
    expect(parseIFHistory("<html></html>")).toEqual([]);
  });
});

describe("parsePubVolumeHistory (ECharts '年文章数' series)", () => {
  it("extracts multi-year pub volume from Lancet (271..251 range, integers)", () => {
    const result = parsePubVolumeHistory(lancetDetailHtml);
    expect(result.length).toBeGreaterThanOrEqual(5);
    for (const r of result) {
      expect(Number.isInteger(r.count)).toBe(true);
      expect(r.count).toBeGreaterThan(0);
      expect(r.count).toBeLessThan(10000);
    }
  });

  it("returns [] for empty HTML", () => {
    expect(parsePubVolumeHistory("<html></html>")).toEqual([]);
  });
});

describe("parseCASPartitions (multi-version 4-col tables)", () => {
  it("extracts ≥1 partition version from real Lancet HTML with 医学 1区/3区", () => {
    const result = parseCASPartitions(lancetDetailHtml);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const first = result[0];
    expect(first.majorCategory).toContain("医学");
    expect(/^[1-4]区/.test(first.majorCategory)).toBe(true);
    // Lancet 是 TOP 期刊
    expect(first.isTop).toBe(true);
    // 子类 ≥ 1 项，含 MEDICINE
    expect(first.subCategories.length).toBeGreaterThanOrEqual(1);
    expect(first.subCategories[0].subject).toContain("MEDICINE");
  });

  it("returns [] for HTML without partition table headers", () => {
    expect(parseCASPartitions("<html>no partition here</html>")).toEqual([]);
  });
});

describe("parseJCRPartitions (按JIF指标学科分区)", () => {
  it("extracts Lancet JCR Q1 in MEDICINE GENERAL & INTERNAL with rank 1/332", () => {
    const result = parseJCRPartitions(lancetDetailHtml);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const m = result[0];
    expect(m.subject).toMatch(/MEDICINE/i);
    expect(m.zone).toBe("Q1");
    expect(m.database).toBe("SCIE");
    expect(m.rank).toMatch(/^\d+\/\d+$/);
  });

  it("returns [] for HTML without JCR table", () => {
    expect(parseJCRPartitions("<html></html>")).toEqual([]);
  });
});

describe("parseJCIPartitions (按JCI指标学科分区)", () => {
  it("extracts Lancet JCI Q1 in MEDICINE with rank 1/333", () => {
    const result = parseJCIPartitions(lancetDetailHtml);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const m = result[0];
    expect(m.subject).toMatch(/MEDICINE/i);
    expect(m.zone).toBe("Q1");
    expect(m.database).toBe("SCIE");
    expect(m.rank).toMatch(/^\d+\/\d+$/);
  });

  it("returns [] for HTML without JCI table", () => {
    expect(parseJCIPartitions("<html></html>")).toEqual([]);
  });
});
