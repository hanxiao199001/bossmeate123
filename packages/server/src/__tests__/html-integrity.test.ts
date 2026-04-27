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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// quality-check-v2 transitively imports chat-service / knowledge-service
vi.mock("../services/ai/chat-service.js", () => ({ chat: vi.fn() }));
vi.mock("../services/knowledge/knowledge-service.js", () => ({ semanticSearch: vi.fn() }));

const { checkHtmlIntegrity } = await import(
  "../services/content-engine/quality-check-v2.js"
);

describe("checkHtmlIntegrity", () => {
  it("passes for clean body with no escaped HTML literals", () => {
    const r = checkHtmlIntegrity(
      `<section style="padding:10px"><p>正常段落</p></section>`
    );
    expect(r.passed).toBe(true);
    expect(r.leakedPatterns).toEqual([]);
  });

  it("passes for empty body", () => {
    expect(checkHtmlIntegrity("").passed).toBe(true);
    expect(checkHtmlIntegrity("").leakedPatterns).toEqual([]);
  });

  it("fails when body contains escaped <strong> literal (T4-3-3 listicle bug repro)", () => {
    const r = checkHtmlIntegrity(
      `<p>1. 这本刊优势在于 &lt;strong&gt;审稿快&lt;/strong&gt; 对赶毕业的博士生友好</p>`
    );
    expect(r.passed).toBe(false);
    expect(r.leakedPatterns.some((p) => /&lt;strong&gt;/i.test(p))).toBe(true);
    expect(r.leakedPatterns.some((p) => /&lt;\/strong&gt;/i.test(p))).toBe(true);
  });

  it("fails on orphan closing tag literal", () => {
    const r = checkHtmlIntegrity(
      `<p>1. 临床转化潜力明显&lt;/strong&gt; 的数据，投它性价比高</p>`
    );
    expect(r.passed).toBe(false);
    expect(r.leakedPatterns).toHaveLength(1);
  });

  it("fails on multiple distinct tag types (strong + p + em)", () => {
    const r = checkHtmlIntegrity(
      `&lt;p&gt;hello&lt;/p&gt; &lt;strong&gt;world&lt;/strong&gt; &lt;em&gt;again&lt;/em&gt;`
    );
    expect(r.passed).toBe(false);
    expect(r.leakedPatterns.length).toBeGreaterThanOrEqual(5);
  });

  it("caps leakedPatterns at 5 even with many leaks", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `&lt;span data-${i}&gt;`).join(" ");
    const r = checkHtmlIntegrity(tags);
    expect(r.passed).toBe(false);
    expect(r.leakedPatterns.length).toBeLessThanOrEqual(5);
  });

  it("detects double-escaped &amp;lt; pattern", () => {
    const r = checkHtmlIntegrity(`正文中混入 &amp;lt;strong&amp;gt; 的双重转义`);
    expect(r.passed).toBe(false);
    expect(r.leakedPatterns.some((p) => /&amp;lt;/.test(p))).toBe(true);
  });

  it("does NOT false-positive on Chinese punctuation or normal entities", () => {
    // 这些是正常 HTML 实体，不应被当作泄漏
    const r = checkHtmlIntegrity(
      `这里有 &nbsp; 空格和 &amp; 符号，还有 &copy; 版权标记，正常段落`
    );
    expect(r.passed).toBe(true);
  });
});
