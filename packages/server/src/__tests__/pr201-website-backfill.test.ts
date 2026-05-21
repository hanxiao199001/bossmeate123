/**
 * 5-22 PR #201 — OpenAlex homepage_url 回填 website (免代理).
 * 根因: 新 5000 LetPub 池 website 多为 NULL → 模板"官网"行被藏 → 文章无官网链接.
 * 修法: OpenAlex homepage_url (事实型 URL) 回填, 仅填 NULL 不覆盖真值, 绝不戳 LetPub.
 */
import { describe, it, expect } from "vitest";
import { extractWebsiteFromOpenAlex } from "../services/journal-enricher/extractors/openalex-extractor.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #201: extractWebsiteFromOpenAlex 行为", () => {
  it("合法 http(s) URL 提取成功", () => {
    expect(extractWebsiteFromOpenAlex({ homepage_url: "https://www.cell.com/cell" } as any)).toBe("https://www.cell.com/cell");
    expect(extractWebsiteFromOpenAlex({ homepage_url: "http://example.org" } as any)).toBe("http://example.org");
  });
  it("非法/缺失/非 http URL 返回 null", () => {
    expect(extractWebsiteFromOpenAlex(null)).toBeNull();
    expect(extractWebsiteFromOpenAlex({} as any)).toBeNull();
    expect(extractWebsiteFromOpenAlex({ homepage_url: null } as any)).toBeNull();
    expect(extractWebsiteFromOpenAlex({ homepage_url: "ftp://x" } as any)).toBeNull();
    expect(extractWebsiteFromOpenAlex({ homepage_url: "journal.com" } as any)).toBeNull();
  });
  it("排除 Springer SSO 登录页 (与模板 isSpringerLogin 同口径)", () => {
    expect(extractWebsiteFromOpenAlex({ homepage_url: "https://idp.springer.com/login?x=1" } as any)).toBeNull();
  });
  it("截断超长 URL 到 500", () => {
    const long = "https://x.com/" + "a".repeat(600);
    expect(extractWebsiteFromOpenAlex({ homepage_url: long } as any)!.length).toBe(500);
  });
});

describe("PR #201: orchestrator 只回填 NULL 不覆盖", () => {
  it("website 回填用 if (!journal.website) 守卫", async () => {
    const src = await readSrc("../services/journal-enricher/orchestrator.ts");
    expect(src).toMatch(/if \(!journal\.website\) \{/);
    expect(src).toMatch(/extractWebsiteFromOpenAlex\(openalex\)/);
    expect(src).toMatch(/realProvenance\.website = "openalex"/);
  });
});

describe("PR #201: backfill 脚本绝不戳 LetPub", () => {
  it("脚本只 import OpenAlex fetcher, 不 import LetPub/scrapling 模块", async () => {
    const src = await readSrc("../scripts/backfill-website-from-openalex.ts");
    expect(src).toMatch(/fetchOpenAlexJournal/);
    // 关键: 没有任何 import/调用 LetPub 或 scrapling 模块 (注释里提 LetPub 是说明用, 不算)
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    for (const l of importLines) {
      expect(l.toLowerCase()).not.toMatch(/letpub|scrapling|crawler/);
    }
  });
  it("只查 website 为 NULL 且有 ISSN 的期刊", async () => {
    const src = await readSrc("../scripts/backfill-website-from-openalex.ts");
    expect(src).toMatch(/isNull\(journals\.website\)/);
    expect(src).toMatch(/isNotNull\(journals\.issn\)/);
  });
});
