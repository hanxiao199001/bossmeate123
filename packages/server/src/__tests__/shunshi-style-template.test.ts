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
  ifHistoryRaw: null,
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
    expect(html).not.toContain("WoS 等级");

    // Frequency (block 10)
    expect(html).toContain("出版周期");
    expect(html).toContain("周刊");

    // Recommendation score (block 15) — NULL → 待评估
    expect(html).toContain("待评估");

    // Summary (block 16)
    expect(html).toContain("综合点评");
    expect(html).toContain("录用率较高且审稿快");

    // Submission advice (block 17) — 6-21: 派生块 renderSubmissionAdviceBlock 已废弃, 改 AI 驱动(ai.submissionAdvice)。
    //   baseAi 未提供 submissionAdvice → 此处不应出现; AI 驱动渲染另由 PR#146 describe 覆盖。
    expect(html).not.toContain("投稿建议");

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

  it("hides P1 placeholder sections when all 8 B-fields NULL (PR #136: 假数据感修复)", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    // PR #136: chart section NULL 时整 section skip, 不再"数据采集中"占位
    expect(html).not.toMatch(/数据采集中/);
    expect(html).not.toMatch(/数据完善中/);
    expect(html).not.toMatch(/敬请期待/);
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

  it("hides basic info rows when fields missing (PR #135/#136: 整行 skip 不再 '暂无')", async () => {
    const j = {
      ...baseJournal,
      foundingYear: null,
      country: null,
      publisher: null,
      issn: null,
      website: null,
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    // PR #135/#136: NULL 整行 skip — basic info card 内不再字面 "暂无"
    expect(html).not.toContain("ISSN：</strong>");
    expect(html).not.toContain("Publisher：</strong>");
    expect(html).not.toContain("创刊年：</strong>");
    expect(html).not.toContain("出版国：</strong>");
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
    expect(html).toContain("WoS 等级");
    expect(html).toContain("SCIE");
    expect(html).toContain("肿瘤学"); // 6-21: jifSubjects 学科名英→中翻译(PR#198), ONCOLOGY→肿瘤学
    expect(html).toContain("是否顶刊");

    // NULL 时整段隐藏（P3）
    const htmlNull = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(htmlNull).not.toContain("WoS 等级");
    expect(htmlNull).not.toMatch(/JCR\s*详细/);
  });

  it("renders CSCD / 北大核心 rows in JCR panel when populated (B.4-1)", async () => {
    // 即便 jcrFull 为 NULL，只要中文核心目录字段有值，区块 7 也应渲染
    const jWithZh = { ...baseJournal, cscdLevel: "核心库", pkuCoreLevel: "北大核心" };
    const html = await generateShunshiStyleHtml(jWithZh, baseAi, undefined);
    expect(html).toMatch(/JCR\s*详细/);
    expect(html).toContain("CSCD");
    expect(html).toContain("核心库");
    expect(html).toContain("北大核心");
    // 没给 jcrFull，所以 WoS 等级 行不渲染
    expect(html).not.toContain("WoS 等级");
  });

  it("hides JCR panel when both jcrFull and CSCD/PKU empty (P3)", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(html).not.toMatch(/JCR\s*详细/);
    expect(html).not.toContain("CSCD");
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
      ifHistoryRaw: {
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

    // PR #136: NULL → 整行 skip (不再 "暂无" 假数据感)
    const htmlNull = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(htmlNull).not.toContain("APC 版面费：");
    expect(htmlNull).not.toContain(">暂无<");
  });
});

// ============ task #35: 区块 21 contact_meta（tenant 入参）============

describe("renderContactBlock — task #35 tenant.contactMeta", () => {
  it("falls back to hardcoded text when tenant arg omitted", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(html).toContain("详见公众号底部二维码 · 工作日 9:00-18:00 答疑");
    expect(html).toContain("联系方式");
  });

  it("falls back to hardcoded text when tenant.contactMeta is null/undefined", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, { contactMeta: null });
    expect(html).toContain("详见公众号底部二维码 · 工作日 9:00-18:00 答疑");
    const html2 = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, { contactMeta: undefined });
    expect(html2).toContain("详见公众号底部二维码 · 工作日 9:00-18:00 答疑");
  });

  it("falls back when contactMeta is malformed (missing contactName)", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, {
      contactMeta: { wechatId: "x", workingHours: "y" } as any,
    });
    expect(html).toContain("详见公众号底部二维码");
  });

  it("renders contactName + workingHours + wechatId when contactMeta valid", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, {
      contactMeta: {
        contactName: "BossMate 期刊小助手",
        wechatId: "bossmate_journal",
        workingHours: "工作日 9:00-18:00 答疑",
      },
    });
    expect(html).toContain("BossMate 期刊小助手");
    expect(html).toContain("bossmate_journal");
    expect(html).toContain("工作日 9:00-18:00 答疑");
    expect(html).toContain("微信：");
    // hardcoded fallback 文案不应再出现
    expect(html).not.toContain("详见公众号底部二维码");
  });

  it("renders qrCodeUrl as <img> when present", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, {
      contactMeta: {
        contactName: "测试小助手",
        qrCodeUrl: "https://cos.example.com/qr.png",
      },
    });
    expect(html).toContain('<img src="https://cos.example.com/qr.png"');
    expect(html).toContain("测试小助手");
  });

  it("hides optional rows when only contactName provided", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, {
      contactMeta: { contactName: "最小小助手" },
    });
    expect(html).toContain("最小小助手");
    expect(html).not.toContain("微信：");
    expect(html).not.toContain("邮箱：");
    expect(html).not.toContain("电话：");
    expect(html).not.toContain('alt="二维码"'); // QR code img absent (cover img unrelated)
  });

  it("escapes HTML in contactMeta fields", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, {
      contactMeta: {
        contactName: "<script>alert(1)</script>",
        wechatId: "id&with<chars>",
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("id&amp;with&lt;chars&gt;");
  });

  it("renders email and phone rows when provided", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined, {
      contactMeta: {
        contactName: "全字段助手",
        email: "ops@bossmate.cn",
        phone: "+86 138-0000-0000",
      },
    });
    expect(html).toContain("邮箱：");
    expect(html).toContain("ops@bossmate.cn");
    expect(html).toContain("电话：");
    expect(html).toContain("+86 138-0000-0000");
  });
});

describe("PR #146: render*Block NULL → 整块 skip (placeholder 残留修复)", () => {
  it("区块5 renderImpactFactorBlock: impactFactor=null → 整块 skip", async () => {
    const html = await generateShunshiStyleHtml({ ...baseJournal, impactFactor: null }, baseAi, undefined);
    expect(html).not.toContain("最新影响因子");
  });

  it("区块5: impactFactor 有值 → 正常渲染", async () => {
    const html = await generateShunshiStyleHtml({ ...baseJournal, impactFactor: 4.7 }, baseAi, undefined);
    expect(html).toContain("最新影响因子");
  });

  it("区块10 renderFrequencyBlock: frequency+publicationStats 都 null → 整块 skip, 无 '未知'", async () => {
    const html = await generateShunshiStyleHtml({ ...baseJournal, frequency: null, publicationStats: null }, baseAi, undefined);
    expect(html).not.toContain("出版周期");
    expect(html).not.toContain(">未知<");
  });

  it("区块10: frequency 有值 → 正常渲染", async () => {
    const html = await generateShunshiStyleHtml({ ...baseJournal, frequency: "月刊" }, baseAi, undefined);
    expect(html).toContain("出版周期");
    expect(html).toContain("月刊");
  });

  // 6-21: 区块17 派生块 renderSubmissionAdviceBlock 已废弃(审稿周期重复 + 矛盾源), 改 AI 驱动 renderAiSubmissionAdvice(ai.submissionAdvice)。
  //   不再依赖 ar/rc; 改测 AI 内容有无。
  it("区块17 投稿建议: ai 无 submissionAdvice → 不渲染", async () => {
    const html = await generateShunshiStyleHtml(baseJournal, baseAi, undefined);
    expect(html).not.toContain("投稿建议");
  });

  it("区块17 投稿建议: ai 有 submissionAdvice → 渲染 💡 投稿建议", async () => {
    const aiWithAdvice = { ...baseAi, submissionAdvice: "<p>建议尽早投稿，注意格式规范与选题契合度。</p>" };
    const html = await generateShunshiStyleHtml(baseJournal, aiWithAdvice, undefined);
    expect(html).toContain("投稿建议");
  });

  it("整体: 所有 P2 字段 null → body 无 暂无/未知/未公开 残留（区块 18/19 含在内）", async () => {
    const html = await generateShunshiStyleHtml(
      { ...baseJournal, impactFactor: null, frequency: null, publicationStats: null, acceptanceRate: null, reviewCycle: null },
      baseAi,
      undefined,
    );
    expect(html).not.toContain(">暂无<");
    expect(html).not.toContain(">未知<");
    expect(html).not.toContain("未公开");
  });
});
