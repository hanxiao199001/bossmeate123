import { describe, it, expect, vi } from "vitest";

// Mock env to avoid env.ts:148 process.exit(1) during collect phase
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

const { generateStorytellingHtml } = await import(
  "../services/publisher/adapters/storytelling-template.js"
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
  apcFee: null,
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
  scopeDescription: "Frontiers in Oncology 收稿范围广，覆盖临床肿瘤学、肿瘤生物学、肿瘤药物等。",
  recommendation:
    "录用率较高，适合中高水平稿件。审稿周期 6-8 周。注意 APC 费用。建议选准 section editor。",
  editorComment: "肿瘤博士的口碑投稿首选！",
} as any;

describe("generateStorytellingHtml", () => {
  it("returns a non-empty HTML string with all 7 blocks present in default flow", async () => {
    const html = await generateStorytellingHtml(baseJournal, baseAi, [
      {
        title: "Sample paper",
        journal: "Frontiers in Oncology",
        pmid: "12345",
        abstractText:
          "Background: Our study investigates novel immunotherapy targets in solid tumors. " +
          "Methods: We performed RNA-seq on 100 patient samples. " +
          "Results: We identified 5 novel biomarkers significantly correlated with overall survival.",
      },
    ]);

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(500);

    // pain-point hook (block 1)
    expect(html).toMatch(/💭/);
    // story intro (block 2) — journal name appears
    expect(html).toContain("Frontiers in Oncology");
    // 4-cell data card (block 3) — labels present
    expect(html).toContain("IF");
    expect(html).toContain("分区");
    expect(html).toContain("录用率");
    expect(html).toContain("审稿周期");
    // case analysis (block 4) — quoted abstract title
    expect(html).toContain("Sample paper");
    expect(html).toMatch(/📚/);
    // submission tips (block 5)
    expect(html).toMatch(/✍️/);
    // CTA (block 6)
    expect(html).toMatch(/第一梯队/);
    // footer cover image (block 7)
    expect(html).toContain("media-cdn.example.com/cover.jpg");
  });

  it("skips case-analysis block when no abstracts are passed", async () => {
    const html = await generateStorytellingHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/📚 该刊近期发文样例/);
    // other required blocks still present
    expect(html).toMatch(/💭/);
    expect(html).toMatch(/✍️/);
  });

  it("skips footer cover when journal.coverUrl missing", async () => {
    const j = { ...baseJournal, coverUrl: null, coverImageUrl: null };
    const html = await generateStorytellingHtml(j, baseAi, undefined);
    expect(html).not.toContain("期刊封面</p>");
  });

  it("uses fallback hook copy when aiContent.editorComment is empty", async () => {
    const ai = { ...baseAi, editorComment: undefined };
    const html = await generateStorytellingHtml(baseJournal, ai, undefined);
    expect(html).toMatch(/还在为/);
    expect(html).toContain("肿瘤学");
  });

  it("derives at least 3 submission tips even when recommendation is short", async () => {
    const ai = { ...baseAi, recommendation: "投稿。" };
    const html = await generateStorytellingHtml(baseJournal, ai, undefined);
    const bulletCount = (html.match(/<span style="color:#FF9800;font-weight:bold;">• <\/span>/g) || []).length;
    expect(bulletCount).toBeGreaterThanOrEqual(3);
  });

  it("WeChat compatibility: HTML contains no flex / grid / class= / id= / position:", async () => {
    const html = await generateStorytellingHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/display\s*:\s*flex/);
    expect(html).not.toMatch(/display\s*:\s*grid/);
    expect(html).not.toMatch(/\sclass=/);
    expect(html).not.toMatch(/\sid=/);
    expect(html).not.toMatch(/position\s*:\s*(absolute|fixed|relative)/);
  });

  it("escapes user-provided strings to prevent injection", async () => {
    const j = { ...baseJournal, name: "<script>alert(1)</script>", nameEn: "<script>alert(1)</script>" };
    const html = await generateStorytellingHtml(j, baseAi, undefined);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;script&gt;");
  });
});
