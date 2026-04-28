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

const { generateShunshiStyleHtml } = await import(
  "../services/publisher/adapters/shunshi-style-template.js"
);

const baseJournal = {
  id: "j-1",
  name: "肿瘤前沿",
  nameEn: "Frontiers in Oncology",
  abbreviation: "Front Oncol",
  issn: "2234-943X",
  publisher: "Frontiers Media",
  discipline: "肿瘤学",
  partition: "Q2",
  casPartition: "2",
  casPartitionNew: "2 区 TOP",
  impactFactor: 4.7,
  acceptanceRate: 0.55,
  reviewCycle: "6-8 周",
  annualVolume: 5000,
  isWarningList: false,
  warningYear: null,
  foundingYear: 2011,
  country: "瑞士",
  website: "https://www.frontiersin.org/journals/oncology",
  apcFee: 2950,
  selfCitationRate: null,
  jcrSubjects: null,
  topInstitutions: null,
  scopeDescription: null,
  frequency: "周刊",
  coverUrl: "https://media-cdn.example.com/cover.jpg",
  dataCardUri: "",
  // B 阶段 8 字段全 NULL（默认）
  ifHistory: null,
  carIndexHistory: null,
  publicationStats: null,
  jcrFull: null,
  citingJournalsTop10: null,
  recommendationScore: null,
  scopeDetails: null,
  publicationCosts: null,
} as any;

const baseAi = {
  title: "影响因子4.7，今年预测涨至5.5，2区TOP，国人友好，是肿瘤学领域内公认的必投SCI！",
  scopeDescription: "Frontiers in Oncology 收稿范围广。",
  recommendation: "录用率较高且审稿快，质量稳定，被引活跃。",
  editorComment: "肿瘤博士口碑首选！",
} as any;

const SECTION_OPEN = /<section\b/g;
const SECTION_CLOSE = /<\/section>/g;

describe("generateShunshiStyleHtml — 23 sections", () => {
  it("renders all required content with default (NULL B-fields) input", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(5000);

    // Hero (block 1)
    expect(html).toContain("Frontiers in Oncology");
    expect(html).toContain("IF 4.7");

    // basic info (block 2)
    expect(html).toContain("ISSN");
    expect(html).toContain("2234-943X");
    expect(html).toContain("Publisher");
    expect(html).toContain("Frontiers Media");
    expect(html).toContain("瑞士");

    // JCR Quartile (block 3)
    expect(html).toContain("Q2");

    // IF latest (block 5)
    expect(html).toContain("最新影响因子");

    // JCR detailed panel (block 7) — P3 隐藏（jcr_full NULL）→ 不出现
    expect(html).not.toContain("WoS Level");

    // Frequency (block 10)
    expect(html).toContain("出版周期");
    expect(html).toContain("周刊");

    // Recommendation score (block 15) — NULL → 待评估
    expect(html).toContain("待评估");

    // Summary (block 16)
    expect(html).toContain("综合点评");
    expect(html).toContain("录用率较高且审稿快");

    // Submission advice (block 17)
    expect(html).toContain("投稿建议");

    // Advantages + cautions (block 18 + 19)
    expect(html).toContain("✅ 优势");
    expect(html).toContain("⚠️ 注意事项");

    // Marketing CTA (block 20)
    expect(html).toContain("需要投稿协助");

    // Contact (block 21)
    expect(html).toContain("联系方式");

    // Disclaimer (block 22)
    expect(html).toContain("免责声明");

    // Footer (block 23)
    expect(html).toContain("数据更新");
  });

  it("renders ≥5 P1 placeholder cards when all 8 B-fields NULL", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    // 数据采集中 出现在每个 P1 占位卡片里
    const matches = html.match(/数据采集中/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(5);
  });

  it("section open/close tags balanced", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    const openCount = (html.match(SECTION_OPEN) || []).length;
    const closeCount = (html.match(SECTION_CLOSE) || []).length;
    expect(openCount).toBe(closeCount);
    expect(openCount).toBeGreaterThan(15);
  });

  it("no literal undefined / null / [object Object] leakage", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/\bundefined\b/);
    expect(html).not.toMatch(/\[object Object\]/);
    // 'null' 单词级别不应出现（class= 等也不应有；字段值若为 null 应渲染为"暂无"）
    expect(html).not.toMatch(/>null</);
    expect(html).not.toMatch(/:\s*null\s*</);
  });

  it("falls back gracefully when basic info fields missing", async () => {
    const j = {
      ...baseJournal,
      foundingYear: null,
      country: null,
      publisher: null,
      issn: null,
      website: null,
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    // 灰阶 fallback：出现"暂无"
    expect(html).toContain("暂无");
    // 主流程不抛错
    expect(html).toContain("Frontiers in Oncology");
  });

  it("skips cover image when both coverUrl and coverImageUrl missing", async () => {
    const j = { ...baseJournal, coverUrl: null, coverImageUrl: null };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    // 不应有 <img>（封面）；其他 <img> 也无
    expect(html).not.toMatch(/<img\s/);
  });

  it("renders JCR full panel when jcr_full populated, hides when null (P3)", async () => {
    const jWithJcr = {
      ...baseJournal,
      jcrFull: {
        wosLevel: "SCIE",
        jifSubjects: [{ subject: "ONCOLOGY", zone: "Q2", rank: "92/241" }],
        isTopJournal: true,
        isReviewJournal: false,
      },
    };
    const html = await generateShunshiStyleHtml(jWithJcr, baseAi, undefined);
    expect(html).toContain("WoS Level");
    expect(html).toContain("SCIE");
    expect(html).toContain("ONCOLOGY");
    expect(html).toContain("Top Journal");

    // NULL 时整段隐藏（P3）
    const htmlNull = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(htmlNull).not.toContain("WoS Level");
    expect(htmlNull).not.toMatch(/JCR\s*详细/);
  });

  it("renders recommendation score stars when 1-5, shows '待评估' for null/invalid", async () => {
    const j5 = { ...baseJournal, recommendationScore: 5 };
    const html5 = await generateShunshiStyleHtml(j5, baseAi, undefined);
    expect(html5).toContain("★★★★★");
    expect(html5).toContain("5 / 5");

    const j3 = { ...baseJournal, recommendationScore: 3 };
    const html3 = await generateShunshiStyleHtml(j3, baseAi, undefined);
    expect(html3).toContain("★★★☆☆");

    const jNull = { ...baseJournal, recommendationScore: null };
    const htmlNull = await generateShunshiStyleHtml(jNull, baseAi, undefined);
    expect(htmlNull).toContain("待评估");

    // 越界值走 fallback
    const jBad = { ...baseJournal, recommendationScore: 99 };
    const htmlBad = await generateShunshiStyleHtml(jBad, baseAi, undefined);
    expect(htmlBad).toContain("待评估");
  });

  it("renders if_history yoy delta when ≥2 data points", async () => {
    const j = {
      ...baseJournal,
      ifHistory: {
        data: [
          { year: 2022, if: 3.5 },
          { year: 2023, if: 4.7 },
        ],
      },
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    // 同比文字应出现（▲ 或 ▼ + 百分比）
    expect(html).toMatch(/[▲▼]/);
    expect(html).toMatch(/同比/);
  });

  it("renders top institutions (block 12) when populated, hides when empty (P3)", async () => {
    const j = {
      ...baseJournal,
      publicationStats: {
        topInstitutions: [
          { name: "复旦大学", paperCount: 120 },
          { name: "上海交通大学", paperCount: 95 },
          { name: "中山大学", paperCount: 80 },
        ],
      },
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).toContain("国内 TOP 5 发文机构");
    expect(html).toContain("复旦大学");
    expect(html).toContain("上海交通大学");
    expect(html).toContain("120 篇");

    // 空数组 → P3 隐藏
    const htmlEmpty = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(htmlEmpty).not.toContain("国内 TOP 5 发文机构");
  });

  it("WeChat compatibility: no flex / grid / class= / id= / position", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/display\s*:\s*flex/);
    expect(html).not.toMatch(/display\s*:\s*grid/);
    expect(html).not.toMatch(/\sclass=/);
    expect(html).not.toMatch(/\sid=/);
    expect(html).not.toMatch(/position\s*:\s*(absolute|fixed|relative)/);
  });

  it("escapes user-provided strings to prevent XSS", async () => {
    const j = {
      ...baseJournal,
      name: "<script>alert(1)</script>",
      nameEn: "<script>alert(1)</script>",
      publisher: "<img onerror=alert(1)>",
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img\s+onerror/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("uses publication_costs APC fields when populated (P2 grey otherwise)", async () => {
    const jWithCosts = {
      ...baseJournal,
      publicationCosts: {
        apc: 2950,
        currency: "USD",
        openAccess: true,
        fastTrack: false,
      },
    };
    const html = await generateShunshiStyleHtml(jWithCosts, baseAi, undefined);
    expect(html).toContain("USD");
    expect(html).toContain("2,950");
    expect(html).toContain("APC 版面费");

    // NULL → P2 灰阶 "暂无"
    const htmlNull = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(htmlNull).toContain("APC 版面费");
    expect(htmlNull).toContain("暂无");
  });
});
