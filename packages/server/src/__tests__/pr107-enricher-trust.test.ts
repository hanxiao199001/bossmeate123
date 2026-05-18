/**
 * PR #107（5-9 治理 PR 3）：enricher 4 源 + trust score 测试。
 *
 * 覆盖：
 *  - crossref fetcher：ISSN 校验 + 404 / 200 / format 错误 / mailto 头
 *  - trust-score：4 源命中组合 + confidence 公式 + dataSource 分级 + provenance
 *  - reverify route：admin guard + 404 / 200
 *  - cron handler 含 'journal-trust-reverify'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(48),
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    DATABASE_URL: "postgres://test/test",
  },
}));

const { computeTrust } = await import("../services/journal-enricher/trust-score.js");

describe("PR #107: trust-score computeTrust 公式", () => {
  it("0 命中 → 50 base, dataSource null（caller 不应改原 data_source）", () => {
    const r = computeTrust({ crossref: false, doaj: false, scimago: false, letpub: false });
    expect(r.confidence).toBe(50);
    expect(r.dataSource).toBe(null);
    expect(r.fieldProvenance).toEqual({});
  });

  it("仅 crossref → 70 (+20), 单源 crossref = multi_source_verified（非 letpub 单源也升）", () => {
    const r = computeTrust({ crossref: true, doaj: false, scimago: false, letpub: false });
    expect(r.confidence).toBe(70);
    expect(r.dataSource).toBe("multi_source_verified");
    expect(r.fieldProvenance.publisher).toBe("crossref");
  });

  it("仅 letpub → 70 (+20), letpub_only（单源 letpub 保守）", () => {
    const r = computeTrust({ crossref: false, doaj: false, scimago: false, letpub: true });
    expect(r.confidence).toBe(70);
    expect(r.dataSource).toBe("letpub_only");
    expect(r.fieldProvenance.if_history).toBe("letpub");
  });

  it("crossref + doaj → 80, multi_source_verified", () => {
    const r = computeTrust({ crossref: true, doaj: true, scimago: false, letpub: false });
    expect(r.confidence).toBe(80);
    expect(r.dataSource).toBe("multi_source_verified");
    expect(r.fieldProvenance.publisher).toBe("crossref");
    expect(r.fieldProvenance.apc).toBe("doaj");
  });

  // PR #166: scimago +15 + sjr/qPartition provenance 已砍 — 3 源 50+20+10+20=100 cap 95
  it("3 源全命中 (crossref+doaj+letpub) → 95 cap, scimago flag 被忽略", () => {
    const r = computeTrust({ crossref: true, doaj: true, scimago: true, letpub: true });
    expect(r.confidence).toBe(95); // base 50+20+10+20=100, cap 95 (PR #166 后 scimago +15 已废, cap 不动)
    expect(r.dataSource).toBe("multi_source_verified");
    expect(r.fieldProvenance.publisher).toBe("crossref");
    expect(r.fieldProvenance.apc).toBe("doaj");
    expect(r.fieldProvenance.sjr).toBeUndefined(); // PR #166: 砍
    expect(r.fieldProvenance.if_history).toBe("letpub");
  });

  it("fieldHints 显式覆盖（letpub publisher 优先）", () => {
    const r = computeTrust(
      { crossref: true, doaj: false, scimago: false, letpub: true },
      { publisher: "letpub" },
    );
    expect(r.fieldProvenance.publisher).toBe("letpub"); // override
  });

  // PR #166: scimago 不再计分, 单 doaj 等于 60 (50+10), 不是 multi (totalHits=1 + !letpub = multi 判定)
  it("doaj 单源 (scimago flag 已废) → 60, multi (因 非 letpub 也算 multi)", () => {
    const r = computeTrust({ crossref: false, doaj: true, scimago: true, letpub: false });
    expect(r.confidence).toBe(60); // 50+10 (scimago +15 砍)
    expect(r.dataSource).toBe("multi_source_verified"); // totalHits=1 且非 letpub → multi (老逻辑保留)
  });
});

describe("PR #107: crossref fetcher 静态校验", () => {
  it("源代码含 mailto + ISSN 校验 + 404/200 分支", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/journal-enricher/fetchers/crossref-fetcher.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/api\.crossref\.org\/journals/);
    expect(src).toMatch(/mailto/);
    expect(src).toMatch(/isValidIssn/);
    expect(src).toMatch(/resp\.status === 404/);
    expect(src).toMatch(/User-Agent.*BossMate-Enricher/);
  });
});

describe("PR #107: orchestrator 集成 trust + 4 源", () => {
  it("orchestrator 含 fetchCrossrefByIssn + fetchScimagoByIssn import", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/journal-enricher/orchestrator.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/fetchCrossrefByIssn/);
    // PR #166: scimago import 已删
    expect(src).not.toMatch(/fetchScimagoByIssn/);
    expect(src).toMatch(/computeTrust/);
  });

  it("orchestrator UPDATE 写 trust 5 列（confidence/dataSource/sourceUrl/lastVerifiedAt/fieldProvenance）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/journal-enricher/orchestrator.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/confidence:\s*trust\.confidence/);
    expect(src).toMatch(/lastVerifiedAt:\s*new Date\(\)/);
    expect(src).toMatch(/dataSource:\s*trust\.dataSource/);
    // PR #165a: trust.fieldProvenance 与 realProvenance 合并成 mergedProvenance, 二者任 1 命中皆 OK
    expect(src).toMatch(/fieldProvenance:\s*(trust\.fieldProvenance|mergedProvenance)/);
    expect(src).toMatch(/sourceUrl/);
  });

  it("orchestrator 仅当 trust.dataSource 非 null 才覆盖（保护 manual_seed_2024 不被擦）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/journal-enricher/orchestrator.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/trust\.dataSource\s*\?\s*\{\s*dataSource/);
  });
});

describe("PR #107: reverify route 静态校验", () => {
  it("journals-audit.ts 含 POST /admin/journals/:id/reverify + admin guard（PR #110 砍 tenant 校验）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../routes/journals-audit.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/post\("\/admin\/journals\/:id\/reverify"/);
    expect(src).toMatch(/isAdmin\(request\.user\.role\)/);
    // PR #110: admin 全局视图，不再校验 tenantId（journals 全局共享数据）
    expect(src).not.toMatch(/eq\(journals\.tenantId,\s*request\.tenantId\)/);
    expect(src).toMatch(/enrichJournal/);
  });
});

describe("PR #107: 30 天 cron 注册", () => {
  it("scheduler 含 'journal-trust-reverify' job type + cron pattern + handler", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/scheduler.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/"journal-trust-reverify"/);
    expect(src).toMatch(/journal-trust-reverify-schedule/);
    expect(src).toMatch(/"0 3 \* \* \*"/); // 每日 03:00
    // handler：30 天前或 NULL 的 row + ASC NULLS FIRST + LIMIT 100
    expect(src).toMatch(/30 \* 24 \* 60 \* 60 \* 1000/);
    expect(src).toMatch(/ASC NULLS FIRST/);
    expect(src).toMatch(/limit\(100\)/);
  });
});

describe("PR #107: 前端 ReverifyButton enable", () => {
  it("AdminJournalsAuditPage 含 ReverifyButton 组件 + api.post /reverify", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/pages/AdminJournalsAuditPage.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/function ReverifyButton/);
    expect(src).toMatch(/api\.post[\s\S]*?reverify/);
    expect(src).toMatch(/<ReverifyButton/);
    // PR 2 时是 disabled 占位，PR 3 已 enable（disabled 仅在 loading 时）
    expect(src).not.toMatch(/PR 3 enricher 接入后实现/);
  });
});
