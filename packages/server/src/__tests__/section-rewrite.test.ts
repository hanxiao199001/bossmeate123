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
    DEEPSEEK_MODEL_REASONER: "deepseek-reasoner",
    DEEPSEEK_MODEL_CHAT: "deepseek-chat",
    QWEN_MODEL_PLUS: "qwen-plus",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

vi.mock("../models/db.js", () => ({ db: {} }));

vi.mock("../models/schema.js", () => ({
  contents: {},
  bossEdits: {},
}));

vi.mock("../services/ai/provider-factory.js", () => ({
  getProviderByName: vi.fn(() => null),
}));

const { splitByH2 } = await import("../services/content-engine/section-rewrite.js");

describe("splitByH2", () => {
  it("returns [] when body has no ## heading", () => {
    const sections = splitByH2("just plain text\nno heading here\n");
    expect(sections).toEqual([]);
  });

  it("returns [] for empty body", () => {
    expect(splitByH2("")).toEqual([]);
    expect(splitByH2("   \n\n\n")).toEqual([]);
  });

  it("splits two simple sections", () => {
    const body = [
      "## 一、肿瘤学投稿现状",
      "录用率较高，审稿周期 6-8 周。",
      "推荐青年学者投稿。",
      "## 二、注意事项",
      "APC 费用较高，自引率偏高。",
    ].join("\n");

    const sections = splitByH2(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("## 一、肿瘤学投稿现状");
    expect(sections[0].headingText).toBe("一、肿瘤学投稿现状");
    expect(sections[0].content).toContain("录用率较高");
    expect(sections[0].startLine).toBe(0);
    expect(sections[0].endLine).toBe(2);

    expect(sections[1].heading).toBe("## 二、注意事项");
    expect(sections[1].headingText).toBe("二、注意事项");
    expect(sections[1].content).toContain("APC 费用");
    expect(sections[1].startLine).toBe(3);
    expect(sections[1].endLine).toBe(4);
  });

  it("preserves Markdown lists / blockquotes / tables inside sections", () => {
    const body = [
      "## 一、五大优势",
      "1. 录用率高",
      "2. 审稿快",
      "",
      "> 老板首选",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| IF  | 4.7 |",
      "## 二、三个避雷",
      "- 学科窄",
    ].join("\n");

    const sections = splitByH2(body);
    expect(sections).toHaveLength(2);
    // section 0 keeps list / blockquote / table
    expect(sections[0].content).toContain("1. 录用率高");
    expect(sections[0].content).toContain("> 老板首选");
    expect(sections[0].content).toContain("| IF  | 4.7 |");
    // section 1 starts at correct line
    expect(sections[1].headingText).toBe("二、三个避雷");
    expect(sections[1].content.trim()).toBe("- 学科窄");
  });

  it("ignores preamble text before first ##", () => {
    const body = [
      "前言：本指南介绍...",
      "重点关注三个方面。",
      "",
      "## 第一节",
      "正文 A",
      "## 第二节",
      "正文 B",
    ].join("\n");

    const sections = splitByH2(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("## 第一节");
    expect(sections[0].startLine).toBe(3);
    expect(sections[1].heading).toBe("## 第二节");
  });

  it("handles single ## section (no trailing sections)", () => {
    const body = ["## 唯一章节", "唯一正文", "更多正文"].join("\n");
    const sections = splitByH2(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingText).toBe("唯一章节");
    expect(sections[0].content).toBe("唯一正文\n更多正文");
    expect(sections[0].endLine).toBe(2);
  });

  it("does NOT split on # (H1) or ### (H3) — only ##", () => {
    const body = [
      "# 这是 H1，不切",
      "## 二、这是 H2，切",
      "### 二.1 这是 H3，不切",
      "正文",
      "## 三、又一个 H2",
      "正文 2",
    ].join("\n");

    const sections = splitByH2(body);
    expect(sections).toHaveLength(2);
    expect(sections[0].headingText).toBe("二、这是 H2，切");
    expect(sections[0].content).toContain("### 二.1");
    expect(sections[1].headingText).toBe("三、又一个 H2");
  });

  it("trims trailing whitespace in headingText", () => {
    const body = "##   带很多空格的标题   \n正文";
    const sections = splitByH2(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingText).toBe("带很多空格的标题");
  });
});
