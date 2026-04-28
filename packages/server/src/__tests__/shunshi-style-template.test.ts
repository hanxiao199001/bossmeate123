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
  jcrSubjects: JSON.stringify([
    { subject: "Oncology", rank: "Q2", position: "92/241" },
  ]),
  topInstitutions: null,
  scopeDescription: null,
  frequency: "周刊",
  coverUrl: "https://media-cdn.example.com/cover.jpg",
  dataCardUri: "",
} as any;

const baseAi = {
  title: "影响因子4.7，今年预测涨至5.5，2区TOP，国人友好，是肿瘤学领域内公认的必投SCI！",
  scopeDescription: "Frontiers in Oncology 收稿范围广。",
  recommendation: "录用率较高且审稿快，质量稳定，被引活跃。",
  editorComment: "肿瘤博士口碑首选！",
} as any;

describe("generateShunshiStyleHtml", () => {
  it("renders all body blocks (2-13) in default flow", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);

    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(800);

    // block 2: 今日期刊推荐
    expect(html).toContain("今日期刊推荐");

    // block 3: 期刊英文全名（红色）
    expect(html).toContain("Frontiers in Oncology");
    expect(html).toMatch(/color:#DC143C/);

    // block 4: 期刊简称
    expect(html).toContain("Front Oncol");

    // block 5: 期刊基本信息
    expect(html).toContain("创刊时间");
    expect(html).toContain("2011");
    expect(html).toContain("出版国家");
    expect(html).toContain("瑞士");
    expect(html).toContain("出版商");
    expect(html).toContain("Frontiers Media");
    expect(html).toContain("ISSN");
    expect(html).toContain("2234-943X");
    expect(html).toContain("期刊官方网站");
    expect(html).toContain("frontiersin.org");

    // block 6: 期刊封面图
    expect(html).toContain("media-cdn.example.com/cover.jpg");
    // 不做虚化（不应有 filter:blur 或 background-image）
    expect(html).not.toMatch(/filter\s*:\s*blur/i);
    expect(html).not.toMatch(/background-image/i);

    // block 7: 近10年的影响因子 + 占位
    expect(html).toContain("近10年的影响因子");
    expect(html).toContain("数据采集中");
    expect(html).toContain("📊");

    // block 8: CAR 指数占位
    expect(html).toContain("CAR 指数");
    expect(html).toContain("2026");
    expect(html).toContain("N/A");

    // block 9: JCR分区
    expect(html).toContain("JCR分区");
    expect(html).toContain("大类学科");
    expect(html).toContain("小类学科");
    expect(html).toContain("Top期刊");
    expect(html).toContain("综述期刊");
    expect(html).toContain("WOS 分区");
    expect(html).toContain("Oncology");

    // block 10/11: 发文情况 + 文字段
    expect(html).toContain("发文情况");
    expect(html).toContain("周刊");
    expect(html).toContain("5000");

    // block 12: 近10年的发文量 + 占位
    expect(html).toContain("近10年的发文量");

    // block 13: CTA
    expect(html).toContain("综合来看");
    expect(html).toMatch(/适合：/);
  });

  it("skips abbreviation block when journal.abbreviation missing", async () => {
    const j = { ...baseJournal, abbreviation: null };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    // 缩写区块整段不应出现（"Front Oncol" 是简称专属字符串）
    expect(html).not.toContain("Front Oncol");
    // 但其他区块仍在
    expect(html).toContain("Frontiers in Oncology");
    expect(html).toContain("今日期刊推荐");
  });

  it("falls back gracefully when basic info fields are all missing", async () => {
    const j = {
      ...baseJournal,
      foundingYear: null,
      country: null,
      publisher: null,
      issn: null,
      website: null,
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    // 主流程不应抛错；这些标签字符串都不应出现
    expect(html).not.toContain("创刊时间");
    expect(html).not.toContain("出版国家");
    expect(html).not.toContain("期刊官方网站");
    // 其他区块仍正常
    expect(html).toContain("今日期刊推荐");
    expect(html).toContain("JCR分区");
  });

  it("skips cover image when both coverUrl and coverImageUrl missing", async () => {
    const j = { ...baseJournal, coverUrl: null, coverImageUrl: null };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).not.toMatch(/<img\s/);
  });

  it("uses chart placeholders when historical data is unavailable", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    // 两张柱状图占位都应出现
    const chartMatches = html.match(/数据采集中/g);
    expect(chartMatches && chartMatches.length).toBeGreaterThanOrEqual(3);
    // dashed 边框 + 灰色文字
    expect(html).toMatch(/border\s*:\s*1px dashed/);
  });

  it("renders fallback when JCR partition data totally absent", async () => {
    const j = {
      ...baseJournal,
      partition: null,
      casPartition: null,
      casPartitionNew: null,
      jcrSubjects: null,
      discipline: null,
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).toContain("JCR分区");
    // 三张表都 absent 时降级成"分区数据采集中"
    expect(html).toContain("分区数据采集中");
  });

  it("WeChat compatibility: no flex / grid / class= / id= / position", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/display\s*:\s*flex/);
    expect(html).not.toMatch(/display\s*:\s*grid/);
    expect(html).not.toMatch(/\sclass=/);
    expect(html).not.toMatch(/\sid=/);
    expect(html).not.toMatch(/position\s*:\s*(absolute|fixed|relative)/);
  });

  it("escapes user-provided strings to prevent XSS injection", async () => {
    const j = {
      ...baseJournal,
      name: "<script>alert(1)</script>",
      nameEn: "<script>alert(1)</script>",
      publisher: "<img onerror=alert(1)>",
      abbreviation: "<svg onload=alert(1)>",
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img\s+onerror/);
    expect(html).not.toMatch(/<svg\s+onload/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders top institutions list when topInstitutions JSON populated", async () => {
    const j = {
      ...baseJournal,
      topInstitutions: JSON.stringify(["复旦大学", "上海交通大学", "中山大学"]),
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).toContain("国内近三年投稿活跃机构：");
    expect(html).toContain("复旦大学");
    expect(html).toContain("上海交通大学");
    expect(html).toContain("中山大学");
  });

  it("uses recommendation summary in CTA when present", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    // recommendation 摘要应出现
    expect(html).toContain("录用率较高且审稿快");
  });
});
