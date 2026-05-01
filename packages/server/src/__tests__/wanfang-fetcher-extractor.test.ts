/**
 * B.4-2: 万方 fetcher + extractor + PIPL 邮箱过滤 单测。
 *
 * fixture: __tests__/fixtures/wanfang-zhyx.html（中华医学杂志真实 SSR HTML）。
 * fetcher: fetch mocked，验 perioId 校验 / UA 池 / Referer / 4xx-5xx / sanity-size。
 * extractor: 验 12 个字段提取 + PIPL 白名单 / 黑名单边界。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = readFileSync(resolve(__dirname, "fixtures/wanfang-zhyx.html"), "utf-8");

const { fetchWanfangPeriodical } = await import("../services/journal-enricher/fetchers/wanfang-fetcher.js");
const { extractWanfangPeriodical, filterEditorEmail } = await import("../services/journal-enricher/extractors/wanfang-extractor.js");

// ============ filterEditorEmail (PIPL) ============

describe("filterEditorEmail (PIPL 白名单)", () => {
  it("通过职务前缀邮箱：editor / office / journal / nmjc / zhyx", () => {
    expect(filterEditorEmail("nmjc@cmaph.org")).toBe("nmjc@cmaph.org");
    expect(filterEditorEmail("editor@example.com")).toBe("editor@example.com");
    expect(filterEditorEmail("office@journal.cn")).toBe("office@journal.cn");
    expect(filterEditorEmail("journal_admin@xxx.org")).toBe("journal_admin@xxx.org");
    expect(filterEditorEmail("ZHYX@cmaph.ORG")).toBe("zhyx@cmaph.org"); // 大小写归一
  });

  it("拦截非白名单前缀（个人邮箱 / 作者 / 审稿人）", () => {
    expect(filterEditorEmail("zhangsan@gmail.com")).toBeUndefined();
    expect(filterEditorEmail("li.wei@pku.edu.cn")).toBeUndefined();
    expect(filterEditorEmail("reviewer123@example.com")).toBeUndefined();
  });

  it("空 / 无效 / 非邮箱字符串 → undefined", () => {
    expect(filterEditorEmail(null)).toBeUndefined();
    expect(filterEditorEmail("")).toBeUndefined();
    expect(filterEditorEmail("not an email")).toBeUndefined();
  });
});

// ============ extractWanfangPeriodical ============

describe("extractWanfangPeriodical (cheerio + 真 fixture)", () => {
  it("从中华医学杂志真 HTML 抽出 12 字段", () => {
    const out = extractWanfangPeriodical({
      html: FIXTURE_HTML,
      perioId: "zhyx",
      url: "https://med.wanfangdata.com.cn/Periodical/Detail/zhyx",
    });
    expect(out).not.toBeNull();
    expect(out!.authorityUnit).toBe("中国科学技术协会");
    expect(out!.organizingUnit).toBe("中华医学会");
    expect(out!.editorInChief).toBe("高润霖");
    expect(out!.cnNumber).toBe("11-2137/R");
    expect(out!.issn).toBe("0376-2491");
    expect(out!.editorPhone).toBe("010-51322161");
    expect(out!.editorFax).toBe("010-85158355");
    expect(out!.submissionAddress).toContain("北京市西城区宣武门");
    expect(out!.postCode).toBe("200030");
    expect(out!.postalCode).toBe("2-588");
    expect(out!.editorEmail).toBe("nmjc@cmaph.org"); // PIPL 白名单通过
    expect(out!.cnImpactFactor).toBe(2.123); // 中信所核心 IF
    expect(out!.pkuCoreDynamic).toBe("北大核心");
    expect(out!.pkuCoreYear).toBe("2023");
    expect(out!.cscdLevelDynamic).toBe("核心库");
    expect(out!.cscdYear).toBe("2025");
    expect(out!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out!.sourceUrl).toContain("/zhyx");
  });

  it("null 输入 → null", () => {
    expect(extractWanfangPeriodical(null)).toBeNull();
  });

  it("空 HTML（无字段）→ null（节省 jsonb 空行）", () => {
    const out = extractWanfangPeriodical({
      html: "<html><body></body></html>",
      perioId: "empty",
      url: "https://x",
    });
    expect(out).toBeNull();
  });

  it("HTML 含个人邮箱 → editorEmail undefined（PIPL 拦截）", () => {
    const html = `<div id="basicInfo"><ul><li><strong>电话：</strong>010-x</li><li><strong>电子邮箱：</strong>zhangsan@gmail.com</li></ul></div>`;
    const out = extractWanfangPeriodical({ html, perioId: "x", url: "https://x" });
    expect(out!.editorEmail).toBeUndefined();
    expect(out!.editorPhone).toBe("010-x");
  });
});

// ============ fetchWanfangPeriodical (mocked) ============

describe("fetchWanfangPeriodical", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("perioId 缺失 → null", async () => {
    expect(await fetchWanfangPeriodical({})).toBeNull();
    expect(await fetchWanfangPeriodical({ perioId: "" })).toBeNull();
  });

  it("perioId 含非法字符（注入防御）→ null", async () => {
    expect(await fetchWanfangPeriodical({ perioId: "../../../etc/passwd" })).toBeNull();
    expect(await fetchWanfangPeriodical({ perioId: "zhyx;rm -rf /" })).toBeNull();
  });

  it("成功路径：返回 html + perioId + url", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => FIXTURE_HTML,
    }));
    const out = await fetchWanfangPeriodical({ perioId: "zhyx" });
    expect(out).not.toBeNull();
    expect(out!.perioId).toBe("zhyx");
    expect(out!.url).toContain("/Periodical/Detail/zhyx");
    expect(out!.html.length).toBeGreaterThan(50000);
  });

  it("4xx → 不重试 + return null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchWanfangPeriodical({ perioId: "zhyx" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on 4xx
  });

  it("HTML <5KB sanity 拦截（错误页 / 空页）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => "<html>error</html>",
    }));
    expect(await fetchWanfangPeriodical({ perioId: "zhyx" })).toBeNull();
  });

  it("发出 Referer = baidu.com + UA 来自 UA 池（反爬）", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, text: async () => FIXTURE_HTML });
    vi.stubGlobal("fetch", fetchMock);
    await fetchWanfangPeriodical({ perioId: "zhyx" });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Referer"]).toBe("https://www.baidu.com/");
    expect(headers["User-Agent"]).toMatch(/Mozilla|Chrome|Safari/);
  });
});
