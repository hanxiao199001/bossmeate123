/**
 * PR #135 V2.5 (5-12 demo blocker): daily-cron diversity + 模板 placeholder 整治.
 * 防回归静态校验.
 */
import { describe, it, expect } from "vitest";

describe("PR #135 daily-cron anti-cluster diversity", () => {
  it("recommendJournals limit 改 5 + usedJournalIds 限流", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/daily-cron.ts", import.meta.url), "utf8");
    expect(src).toMatch(/limit:\s*5/);
    expect(src).toMatch(/MAX_PER_JOURNAL_24H\s*=\s*1/); // PR #183: 2→1 批内期刊唯一
    expect(src).toMatch(/journalUseCount24h/); // PR #172: renamed journalUseCount → journalUseCount24h
    expect(src).toMatch(/usedJournalIds\.has/); // PR #183: 批内唯一守卫
    expect(src).toMatch(/anti-cluster/);
  });
});

describe("PR #135 shunshi-style 模板 NULL 字段不渲染", () => {
  it("renderBasicInfoBlock NULL 字段整行 skip (不再 greyOrValue 整 4 行)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/publisher/adapters/shunshi-style-template.ts", import.meta.url), "utf8");
    // 反向断言: renderBasicInfoBlock 内不再无条件 push greyOrValue (lines 数组初始空)
    expect(src).toMatch(/const lines: string\[\] = \[\];\s*\n\s*if \(journal\.issn\)/);
    // 4 字段都用 if guard
    expect(src).toMatch(/if \(journal\.issn\)/);
    expect(src).toMatch(/if \(journal\.publisher\)/);
    expect(src).toMatch(/if \(journal\.foundingYear\)/);
    expect(src).toMatch(/if \(journal\.country\)/);
  });

  it("renderHeroBlock IF badge NULL/0 时 skip (不再灰 'IF 暂无')", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/publisher/adapters/shunshi-style-template.ts", import.meta.url), "utf8");
    // 反向: 不存在 "IF 暂无" 灰 badge HTML (允许注释里描述)
    expect(src).not.toMatch(/border-radius:8px[^"]*">IF 暂无</);
    // ifBadge 三元 NULL 分支返空字符串
    expect(src).toMatch(/impactFactor != null && journal\.impactFactor > 0/);
  });

  it("greyOrValue fallback 改 '未公开'（原 '暂无' 假数据感）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/publisher/adapters/shunshi-style-template.ts", import.meta.url), "utf8");
    expect(src).toMatch(/fallback\s*=\s*"未公开"/);
    // 防回归: 函数 signature 不再 default "暂无"
    expect(src).not.toMatch(/function greyOrValue\(v: unknown, fallback = "暂无"\)/);
  });
});
