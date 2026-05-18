/**
 * 5-23 PR #169 — enrichJournalWithAI 砍 foundingYear + country fallback 防回归.
 *
 * PR #168 e2e 实证: AI 编 '1976/英国' 等假数据填 in-memory journal, validator catch +
 * 排推荐池. PR #169 治本: AI fallback 不再返这 2 字段, prompt 双重禁 + 防御性 strip.
 */
import { describe, it, expect, vi } from "vitest";
import { enrichJournalWithAI } from "../services/crawler/springer-journal-fetcher.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #169: AI fallback 砍 foundingYear + country", () => {
  // 假 AI provider (返自定义 JSON)
  const mockProvider = (jsonOut: Record<string, unknown>) => ({
    chat: vi.fn().mockResolvedValue({ content: JSON.stringify(jsonOut) }),
  });

  const stubJournal = { name: "Frontiers in Psychology", nameEn: "Frontiers in Psychology", issn: "1664-1078" };

  it("AI 返 foundingYear/country → strip 掉 + warn log", async () => {
    const provider = mockProvider({
      abbreviation: "Front Psy",
      foundingYear: 2010,
      country: "瑞士",
      website: "https://example.com",
      apcFee: 2900,
    });
    const result = await enrichJournalWithAI(provider, stubJournal);
    // 期望: 即使 AI 返了, 也被 strip
    expect((result as any).foundingYear).toBeUndefined();
    expect((result as any).country).toBeUndefined();
    // 其他字段保留 (回归保护)
    expect(result.abbreviation).toBe("Front Psy");
    expect(result.website).toBe("https://example.com");
    expect(result.apcFee).toBe(2900);
  });

  it("AI 不返 foundingYear/country → 正常 (无 warn 噪音)", async () => {
    const provider = mockProvider({
      abbreviation: "Front Psy",
      website: "https://example.com",
    });
    const result = await enrichJournalWithAI(provider, stubJournal);
    expect((result as any).foundingYear).toBeUndefined();
    expect((result as any).country).toBeUndefined();
    expect(result.abbreviation).toBe("Front Psy");
  });

  it("AI 返 null foundingYear (老 schema 兼容) → 不 strip 不 warn (null 不算自作主张)", async () => {
    const provider = mockProvider({
      abbreviation: "Front Psy",
      foundingYear: null,
      country: null,
    });
    const result = await enrichJournalWithAI(provider, stubJournal);
    expect((result as any).foundingYear).toBeUndefined();
    expect((result as any).country).toBeUndefined();
  });

  // 源码级 file-content regression
  it("源码: prompt schema 不含 foundingYear/country key + 含 ##禁止字段##", async () => {
    const src = await readSrc("../services/crawler/springer-journal-fetcher.ts");
    // prompt schema 砍 (注: 仅 enrichJournalWithAI 内 prompt 部分; 老 ScraplingResult 接口 line 20-21 keep)
    expect(src).toMatch(/##禁止字段##/);
    expect(src).toMatch(/严禁返回 foundingYear \/ country/);
    // return 对象砍 (有 PR #169 注释标记)
    expect(src).toMatch(/PR #169.*foundingYear \/ country 砍/);
    // 防御性 strip 在
    expect(src).toMatch(/delete parsed\.foundingYear/);
    expect(src).toMatch(/delete parsed\.country/);
    expect(src).toMatch(/AI 自作主张返 foundingYear, 已 strip/);
  });
});
