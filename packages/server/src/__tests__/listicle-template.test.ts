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

const { generateListicleHtml } = await import(
  "../services/publisher/adapters/listicle-template.js"
);

const baseJournal = {
  id: "j-1",
  name: "肿瘤学前沿",
  nameEn: "Frontiers in Oncology",
  issn: "2234-943X",
  publisher: "Frontiers Media",
  discipline: "肿瘤学",
  partition: "Q3",
  casPartition: "3",
  impactFactor: 4.7,
  acceptanceRate: 0.55,
  reviewCycle: "6-8 周",
  annualVolume: 5000,
  isWarningList: false,
  warningYear: null,
  abbreviation: null,
  foundingYear: 2011,
  country: null,
  website: null,
  apcFee: 2950,
  selfCitationRate: null,
  casPartitionNew: null,
  jcrSubjects: null,
  topInstitutions: null,
  scopeDescription: null,
  coverUrl: "https://media-cdn.example.com/cover.jpg",
  dataCardUri: "",
} as any;

const baseAi = {
  title: "肿瘤学投稿指南",
  scopeDescription: "Frontiers in Oncology 收稿范围广。",
  recommendation:
    "录用率较高且审稿快，质量稳定，被引活跃。注意 APC 费用偏高，自引率需要控制，新手作者要严格遵守格式规范。",
  editorComment: "肿瘤博士口碑首选！",
} as any;

describe("generateListicleHtml", () => {
  it("returns non-empty HTML with all 8 sections in default flow", async () => {
    const html = await generateListicleHtml(baseJournal, baseAi, undefined);

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(800);

    // hook title (block 1)
    expect(html).toContain("Frontiers in Oncology");
    expect(html).toMatch(/5 大优势/);

    // 4-cell card labels (block 2)
    expect(html).toContain("IF");
    expect(html).toContain("分区");
    expect(html).toContain("录用率");
    expect(html).toContain("审稿周期");

    // 4 list block headings (blocks 3-6)
    expect(html).toContain("✅ 5 大优势");
    expect(html).toContain("⚠️ 3 个注意事项");
    expect(html).toContain("🎯 适合人群");
    expect(html).toContain("❌ 不适合的情况");

    // CTA + footer cover (blocks 7-8)
    expect(html).toMatch(/综合来看/);
    expect(html).toContain("media-cdn.example.com/cover.jpg");
  });

  it("renders ≥5 advantage items (numbered 1.-5.) even with sparse AI input", async () => {
    const html = await generateListicleHtml(baseJournal, { ...baseAi, recommendation: "短。" }, undefined);
    expect(html).toContain("1.");
    expect(html).toContain("5.");
  });

  it("renders ≥3 caution items even with sparse AI input", async () => {
    // count distinct numbered list items inside the cautions block
    const html = await generateListicleHtml(
      { ...baseJournal, isWarningList: true, warningYear: 2024 },
      { ...baseAi, recommendation: "" },
      undefined
    );
    // Cautions header should be present
    expect(html).toContain("⚠️ 3 个注意事项");
    // Warning list status should surface in caution copy
    expect(html).toContain("预警名单");
  });

  it("renders ≥3 audience items derived from journal data", async () => {
    const html = await generateListicleHtml(baseJournal, baseAi, undefined);
    expect(html).toContain("🎯 适合人群");
    // Q3 / 3 区 + 较高录用率 → 至少有 1 条匹配
    expect(html).toMatch(/硕博|青年|快速|科研/);
  });

  it("skips footer cover when both cover fields missing", async () => {
    const j = { ...baseJournal, coverUrl: null, coverImageUrl: null };
    const html = await generateListicleHtml(j, baseAi, undefined);
    expect(html).not.toContain("期刊封面</p>");
  });

  it("WeChat compatibility: HTML contains no flex / grid / class= / id= / position", async () => {
    const html = await generateListicleHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/display\s*:\s*flex/);
    expect(html).not.toMatch(/display\s*:\s*grid/);
    expect(html).not.toMatch(/\sclass=/);
    expect(html).not.toMatch(/\sid=/);
    expect(html).not.toMatch(/position\s*:\s*(absolute|fixed|relative)/);
  });

  it("escapes user-provided strings to prevent XSS injection", async () => {
    const j = { ...baseJournal, name: "<script>alert(1)</script>", nameEn: "<script>alert(1)</script>" };
    const html = await generateListicleHtml(j, baseAi, undefined);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;script&gt;");
  });

  // ============ 修 listicle 字面 HTML/Markdown 泄漏 bug（T4-3-3 实测发现） ============

  it("strips inline <strong>/<em> from AI recommendation before splitting", async () => {
    const ai = {
      ...baseAi,
      // 句子 ≥ 8 字 才能通过 splitToShortItems 长度过滤
      recommendation:
        "本刊审稿<strong>效率非常快</strong>。整体质量<em>持续稳定可靠</em>。被引数据十分活跃。国际可见度普遍较高。学界认可度普遍较好。",
    };
    const html = await generateListicleHtml(baseJournal, ai, undefined);
    // 不应有字面 escaped tag（&lt;strong&gt; / &lt;/strong&gt;）
    expect(html).not.toMatch(/&lt;\/?strong&gt;/i);
    expect(html).not.toMatch(/&lt;\/?em&gt;/i);
    // 文字内容应被保留（去除标签后的连贯文本）
    expect(html).toContain("本刊审稿效率非常快");
    expect(html).toContain("整体质量持续稳定可靠");
  });

  it("strips Markdown ** bold ** and * italic * before splitting", async () => {
    const ai = {
      ...baseAi,
      recommendation:
        "**本刊审稿效率非常快**。**整体质量持续稳定可靠**。*被引数据十分活跃*。国际可见度普遍较高。学界认可度普遍较好。",
    };
    const html = await generateListicleHtml(baseJournal, ai, undefined);
    // 不应有字面 ** / 单独 *
    expect(html).not.toMatch(/\*\*/);
    // 文字保留（被 ** 和 * 包裹的内容应去掉标记后保留）
    expect(html).toContain("本刊审稿效率非常快");
    expect(html).toContain("整体质量持续稳定可靠");
    expect(html).toContain("被引数据十分活跃");
  });

  it("handles mixed HTML + Markdown without leaking literal tags (T4-3-3 bug repro)", async () => {
    const ai = {
      ...baseAi,
      // 复刻 T4-3-3 实测发现的破损模式：开始/结束标签可能横跨切句边界
      recommendation:
        "<p>本刊审稿<strong>效率非常快</strong>且质量稳定可靠</p>。**被引数据十分活跃**且认可度高。临床转化潜力*持续较高*。学界友好度普遍较好。国际可见度普遍较广。",
    };
    const html = await generateListicleHtml(baseJournal, ai, undefined);
    // 全部 escaped tag 字面量都不应出现
    expect(html).not.toMatch(/&lt;\/?strong&gt;/i);
    expect(html).not.toMatch(/&lt;\/?em&gt;/i);
    expect(html).not.toMatch(/&lt;\/?p&gt;/i);
    expect(html).not.toMatch(/\*\*/);
    // 没有孤儿闭合标签字面量（即不应出现像 "...的数据&lt;/strong&gt;" 的泄漏）
    expect(html).not.toMatch(/&lt;\//);
  });
});
