import { describe, it, expect, vi } from "vitest";

// Mock env (avoids env.ts:148 process.exit(1) in collect phase)
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
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock the wechat template (registry imports it for default registration)
vi.mock("../services/publisher/adapters/wechat-article-template.js", () => ({
  generateWechatJournalArticleHtml: vi.fn(async () => "<html>mocked</html>"),
}));

const {
  registerTemplate,
  getTemplate,
  listTemplates,
  getDefaultTemplateId,
  DEFAULT_TEMPLATE_ID,
} = await import("../services/skills/template-registry.js");

describe("template-registry", () => {
  it("DEFAULT_TEMPLATE_ID is 'data-card'", () => {
    expect(DEFAULT_TEMPLATE_ID).toBe("data-card");
    expect(getDefaultTemplateId()).toBe("data-card");
  });

  it("listTemplates returns at least the built-in 'data-card'", () => {
    const all = listTemplates();
    const ids = all.map((t) => t.id);
    expect(ids).toContain("data-card");
  });

  it("getTemplate('data-card') returns the built-in registration with name/description/icon/htmlGenerator", () => {
    const t = getTemplate("data-card");
    expect(t).not.toBeNull();
    expect(t!.id).toBe("data-card");
    expect(t!.name).toBe("数据卡片型");
    expect(t!.description).toMatch(/数据/);
    expect(t!.icon).toBe("📊");
    expect(typeof t!.htmlGenerator).toBe("function");
  });

  it("getTemplate('does-not-exist') returns null", () => {
    expect(getTemplate("does-not-exist")).toBeNull();
  });

  it("registerTemplate adds new template; can be retrieved by id", () => {
    registerTemplate({
      id: "test-template-x",
      name: "Test X",
      description: "for unit test only",
      htmlGenerator: async () => "<x></x>",
    });
    const t = getTemplate("test-template-x");
    expect(t).not.toBeNull();
    expect(t!.name).toBe("Test X");
  });

  it("registerTemplate with duplicate id overwrites silently (warn-only, no throw)", () => {
    registerTemplate({
      id: "dup-test",
      name: "First",
      description: "v1",
      htmlGenerator: async () => "<v1/>",
    });
    expect(() =>
      registerTemplate({
        id: "dup-test",
        name: "Second",
        description: "v2",
        htmlGenerator: async () => "<v2/>",
      })
    ).not.toThrow();
    const t = getTemplate("dup-test");
    expect(t!.name).toBe("Second");
  });

  it("htmlGenerator on the registered template is callable and returns string", async () => {
    const t = getTemplate("data-card");
    expect(t).not.toBeNull();
    // Built-in points at the mocked wechat template above
    const html = await t!.htmlGenerator(
      { id: "j-1", name: "Test J", nameEn: "Test J", impactFactor: 1, partition: "Q1" } as any,
      { title: "T", scopeDescription: "S", recommendation: "R" } as any,
      undefined
    );
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});
