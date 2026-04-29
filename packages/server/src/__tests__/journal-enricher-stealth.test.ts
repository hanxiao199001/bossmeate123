/**
 * B.2.1.B unit tests
 *  - top-institutions extractor (cheerio fixture)
 *  - scope-details extractor (LLM mocked)
 *  - publication-costs LLM extension (mocked)
 *  - extractMainText / extractApcSection helpers
 *
 * 不在范围（runtime / integration）：
 *  - stealth-fetcher 真实 puppeteer launch（需 chrome runtime，CI 不跑）
 *  - 实 Scimago 抓取（dev only，单独 recon 脚本）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    CREDENTIALS_KEY: "test-credentials-key",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    ALLOWED_ORIGINS: "http://localhost:3000",
    DEEPSEEK_API_KEY: "sk-fake",
    DEEPSEEK_MODEL_CHAT: "deepseek-chat",
    DEEPSEEK_MODEL_REASONER: "deepseek-reasoner",
    QWEN_API_KEY: "sk-fake",
    QWEN_MODEL_PLUS: "qwen-plus",
    MODEL_CIRCUIT_BREAKER_THRESHOLD: 3,
    AI_FALLBACK_STRATEGY: "serial",
    AI_REQUEST_TIMEOUT_MS: 30000,
    AI_ARTICLE_TIMEOUT_MS: 60000,
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

// Mock chat-service so LLM extractors don't make network calls
const mockChat = vi.fn();
vi.mock("../services/ai/chat-service.js", () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

const { extractTopInstitutions } = await import(
  "../services/journal-enricher/extractors/top-institutions-extractor.js"
);
const { extractMainText, extractScopeDetails } = await import(
  "../services/journal-enricher/extractors/scope-details-extractor.js"
);
const { extractApcSection, extractPublicationCostsFromWebsite } = await import(
  "../services/journal-enricher/extractors/publication-costs-extractor.js"
);
const { extractPublicationStats } = await import(
  "../services/journal-enricher/extractors/publication-stats-extractor.js"
);

// ============ Scimago fixture HTML ============

const SCIMAGO_TABLE_FIXTURE = `<!doctype html>
<html><head><title>Scimago Journal & Country Rank</title></head><body>
<div id="content">
  <h2>The Lancet</h2>
  <table>
    <thead><tr><th>Institution</th><th>Country</th><th>Documents</th><th>Percentile</th></tr></thead>
    <tbody>
      <tr><td>Harvard Medical School</td><td>United States</td><td>342</td><td>99</td></tr>
      <tr><td>University of Oxford</td><td>United Kingdom</td><td>287</td><td>97</td></tr>
      <tr><td>Imperial College London</td><td>United Kingdom</td><td>234</td><td>95</td></tr>
      <tr><td>Stanford University</td><td>United States</td><td>198</td><td>93</td></tr>
      <tr><td>Tsinghua University</td><td>China</td><td>156</td><td>90</td></tr>
      <tr><td>(Below Top 5 — should be cut)</td><td>X</td><td>5</td><td>1</td></tr>
    </tbody>
  </table>
  <a href="/journalsearch.php?q=other">Other</a>
</div>
</body></html>`;

const SCIMAGO_ANCHORS_FIXTURE = `<!doctype html>
<html><head><title>scimagojr</title></head><body>
<a href="/institutionsearch.php?q=harvard">Harvard University</a>
<a href="/institutionsearch.php?q=mit">MIT</a>
<a href="/journalsearch.php?q=other">unrelated</a>
</body></html>`;

const NON_SCIMAGO_HTML = `<!doctype html><html><head><title>random</title></head><body><p>foo</p></body></html>`;

const CF_CHALLENGE_FIXTURE = `<!doctype html><html><head><title>Just a moment...</title></head><body>checking your browser</body></html>`;

// ============ extractTopInstitutions ============

describe("extractTopInstitutions", () => {
  it("parses top 5 from Scimago institution table", () => {
    const out = extractTopInstitutions(SCIMAGO_TABLE_FIXTURE);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(5);
    expect(out![0]).toEqual({
      name: "Harvard Medical School",
      country: "United States",
      paperCount: 342,
      percentile: 99,
    });
    expect(out![4].name).toBe("Tsinghua University");
    expect(out![4].country).toBe("China");
  });

  it("falls back to institutionsearch anchors when no table", () => {
    const out = extractTopInstitutions(SCIMAGO_ANCHORS_FIXTURE);
    expect(out).not.toBeNull();
    expect(out!.map((r) => r.name)).toEqual(["Harvard University", "MIT"]);
  });

  it("returns null on non-Scimago HTML (defensive guard)", () => {
    expect(extractTopInstitutions(NON_SCIMAGO_HTML)).toBeNull();
  });

  it("returns null on Cloudflare challenge HTML (no scimago marker)", () => {
    expect(extractTopInstitutions(CF_CHALLENGE_FIXTURE)).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(extractTopInstitutions(null)).toBeNull();
    expect(extractTopInstitutions("")).toBeNull();
    expect(extractTopInstitutions("<html/>")).toBeNull();
  });
});

// ============ extractPublicationStats with topInstitutions merge ============

describe("extractPublicationStats with topInstitutions", () => {
  it("includes topInstitutions when provided", () => {
    const out = extractPublicationStats({
      letpub: null,
      journalFrequency: "周刊",
      topInstitutions: [{ name: "Harvard", paperCount: 100 }],
    });
    expect(out).not.toBeNull();
    expect(out!.topInstitutions).toEqual([{ name: "Harvard", paperCount: 100 }]);
  });

  it("returns non-null even when only topInstitutions present", () => {
    const out = extractPublicationStats({
      letpub: null,
      journalFrequency: null,
      topInstitutions: [{ name: "Oxford" }],
    });
    expect(out).not.toBeNull();
    expect(out!.topInstitutions?.[0].name).toBe("Oxford");
  });

  it("filters empty-name rows", () => {
    const out = extractPublicationStats({
      letpub: null,
      journalFrequency: "月刊",
      topInstitutions: [{ name: "" }, { name: "  " }, { name: "Real Lab" }],
    });
    expect(out!.topInstitutions).toEqual([{ name: "Real Lab" }]);
  });

  it("still returns null when ALL three sources empty", () => {
    expect(
      extractPublicationStats({ letpub: null, journalFrequency: null, topInstitutions: null }),
    ).toBeNull();
    expect(
      extractPublicationStats({ letpub: null, journalFrequency: null, topInstitutions: [] }),
    ).toBeNull();
  });
});

// ============ extractMainText ============

describe("extractMainText (scope-details helper)", () => {
  it("strips script/style/nav/footer", () => {
    const html = `<html><body>
      <nav>top nav</nav>
      <header>header content</header>
      <main><p>real ${"x".repeat(300)} content</p></main>
      <footer>footer content</footer>
      <script>console.log('ignore me');</script>
      <style>.foo { color: red; }</style>
    </body></html>`;
    const text = extractMainText(html);
    expect(text).toContain("real");
    expect(text).not.toContain("top nav");
    expect(text).not.toContain("footer content");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain(".foo");
  });

  it("falls back to body when main is short", () => {
    const html = `<html><body><p>${"a".repeat(500)}</p></body></html>`;
    const text = extractMainText(html);
    expect(text.length).toBeGreaterThan(400);
  });

  it("caps length at MAX_INPUT_CHARS", () => {
    const big = "<html><body><main>" + "x".repeat(20000) + "</main></body></html>";
    const text = extractMainText(big);
    expect(text.length).toBeLessThanOrEqual(6000);
  });
});

// ============ extractScopeDetails (LLM mocked) ============

describe("extractScopeDetails", () => {
  beforeEach(() => {
    mockChat.mockReset();
  });

  it("parses LLM JSON output into shape", async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        categories: [
          { title: "Clinical Research", description: "Original clinical trials" },
          { title: "Reviews", description: "Narrative and systematic reviews" },
        ],
        articleTypes: ["Original Research", "Review", "Commentary"],
        submissionNote: "Manuscripts must follow ICMJE guidelines.",
        subjectDistribution: [
          { subject: "Cardiology", percent: 25 },
          { subject: "Oncology", percent: 18 },
        ],
      }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 100,
      outputTokens: 50,
    });

    const out = await extractScopeDetails({
      websiteHtml: `<html><body><main>${"about the journal scope ".repeat(50)}</main></body></html>`,
      journalName: "The Lancet",
      tenantId: "00000000-0000-0000-0000-000000000001",
    });
    expect(out).not.toBeNull();
    expect(out!.categories?.length).toBe(2);
    expect(out!.articleTypes).toContain("Original Research");
    expect(out!.subjectDistribution?.[0]).toEqual({ subject: "Cardiology", percent: 25 });
    expect(out!.source).toBe("journal_website_llm");
    expect(typeof out!.lastUpdatedAt).toBe("string");
  });

  it("clamps percent to 0-100", async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        categories: [],
        articleTypes: [],
        submissionNote: "",
        subjectDistribution: [
          { subject: "X", percent: 150 },
          { subject: "Y", percent: -10 },
        ],
      }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractScopeDetails({
      websiteHtml: `<html><body><main>${"scope ".repeat(50)}</main></body></html>`,
      journalName: "X",
      tenantId: "tenant-1",
    });
    expect(out!.subjectDistribution).toEqual([
      { subject: "X", percent: 100 },
      { subject: "Y", percent: 0 },
    ]);
  });

  it("returns null on null website html", async () => {
    const out = await extractScopeDetails({
      websiteHtml: null,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("returns null when LLM throws", async () => {
    mockChat.mockRejectedValueOnce(new Error("API timeout"));
    const out = await extractScopeDetails({
      websiteHtml: `<html><body><main>${"scope ".repeat(50)}</main></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
  });

  it("returns null when LLM returns non-JSON garbage", async () => {
    mockChat.mockResolvedValueOnce({
      content: "I don't know — sorry, no JSON here.",
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractScopeDetails({
      websiteHtml: `<html><body><main>${"scope ".repeat(50)}</main></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
  });

  it("returns null when all extracted fields are empty", async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        categories: [],
        articleTypes: [],
        submissionNote: "",
        subjectDistribution: [],
      }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractScopeDetails({
      websiteHtml: `<html><body><main>${"scope ".repeat(50)}</main></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
  });
});

// ============ extractApcSection helper ============

describe("extractApcSection", () => {
  it("captures APC neighborhood", () => {
    const html = `<html><body>
      <p>This journal is open access. The Article Processing Charge is 2950 USD per accepted manuscript. VAT may apply.</p>
      <p>Some other unrelated content about editorial process.</p>
    </body></html>`;
    const text = extractApcSection(html);
    expect(text.toLowerCase()).toContain("article processing charge");
    expect(text).toContain("2950");
  });

  it("falls back to full body when no APC keyword", () => {
    const html = `<html><body><p>About the editorial board and aims.</p></body></html>`;
    const text = extractApcSection(html);
    expect(text).toContain("editorial board");
  });
});

// ============ extractPublicationCostsFromWebsite (LLM mocked) ============

describe("extractPublicationCostsFromWebsite", () => {
  it("returns shape on valid LLM output", async () => {
    mockChat.mockReset();
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ apc: 2950, currency: "USD", openAccess: true, fastTrack: false }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractPublicationCostsFromWebsite({
      websiteHtml: `<html><body><p>The Article Processing Charge is 2950 USD per accepted manuscript. VAT may apply for EU authors. ${"Additional details about open access and license terms apply. ".repeat(5)}</p></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).not.toBeNull();
    expect(out!.apc).toBe(2950);
    expect(out!.currency).toBe("USD");
    expect(out!.openAccess).toBe(true);
    expect(out!.source).toBe("journal_website_llm");
  });

  it("returns null when LLM says apc=null (no APC info on site)", async () => {
    mockChat.mockReset();
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ apc: null, currency: null, openAccess: null, fastTrack: false }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractPublicationCostsFromWebsite({
      websiteHtml: `<html><body><p>nothing about APC here.</p></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
  });

  it("rejects out-of-range apc", async () => {
    mockChat.mockReset();
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ apc: 999999, currency: "USD" }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractPublicationCostsFromWebsite({
      websiteHtml: `<html><body><p>weird page.</p></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
  });

  it("normalizes lowercase currency", async () => {
    mockChat.mockReset();
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ apc: 1500, currency: "eur" }),
      model: "qwen-plus",
      provider: "qwen",
      inputTokens: 0,
      outputTokens: 0,
    });
    const out = await extractPublicationCostsFromWebsite({
      websiteHtml: `<html><body><p>The article processing charge for accepted manuscripts is EUR 1500. ${"Authors should review the open access policy carefully before submission. ".repeat(5)}</p></body></html>`,
      journalName: "X",
      tenantId: "t",
    });
    expect(out!.currency).toBe("EUR");
  });

  it("returns null on null html (skip path)", async () => {
    const out = await extractPublicationCostsFromWebsite({
      websiteHtml: null,
      journalName: "X",
      tenantId: "t",
    });
    expect(out).toBeNull();
  });
});
