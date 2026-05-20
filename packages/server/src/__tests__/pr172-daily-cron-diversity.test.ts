/**
 * PR #172 — 每日推荐多样性: 3 层去重 + 学科轮换
 *
 * 静态校验 + schema/migration 校验 + 源码结构守卫
 */
import { describe, it, expect } from "vitest";

describe("PR #172: daily-cron.ts 多样性结构守卫", () => {
  it("含 3 层去重 + 学科轮换 + fallback 关键结构", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/recommendation/daily-cron.ts", import.meta.url),
      "utf8",
    );
    // Layer 1: keyword cooldown
    expect(src).toMatch(/KEYWORD_COOLDOWN_DAYS\s*=\s*30/);
    expect(src).toMatch(/lastRecommendedAt/);
    // Layer 2: journal 30d 限流
    expect(src).toMatch(/JOURNAL_MAX_PER_30D\s*=\s*5/);
    expect(src).toMatch(/getJournal30dCount/);
    // Layer 3: 学科轮换
    expect(src).toMatch(/DISCIPLINE_ROTATION/);
    // PR #135 anti-cluster — PR #183 改 2→1 (批内期刊唯一)
    expect(src).toMatch(/MAX_PER_JOURNAL_24H\s*=\s*1/);
    // Fallback 3 级
    expect(src).toMatch(/fallbackLevel/);
    expect(src).toMatch(/fallback A/);
    expect(src).toMatch(/fallback B/);
    expect(src).toMatch(/fallback C/);
    // diversityStats 输出
    expect(src).toMatch(/uniqueJournals/);
    expect(src).toMatch(/diversityStats/);
  });

  it("DISCIPLINE_ROTATION 覆盖 7 天 (0-6)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/recommendation/daily-cron.ts", import.meta.url),
      "utf8",
    );
    // 验证 DISCIPLINE_ROTATION 包含 0-6 所有 key
    const rotationBlock = src.match(/DISCIPLINE_ROTATION[\s\S]*?\{([\s\S]*?)\};/)?.[1] ?? "";
    for (let d = 0; d <= 6; d++) {
      expect(rotationBlock).toContain(`${d}:`);
    }
  });

  it("保留 PR #130 核心接口: RECOMMENDATION_BATCH_SIZE=10 + FRESH_APPEAR_COUNT_MAX=7", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/recommendation/daily-cron.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/RECOMMENDATION_BATCH_SIZE\s*=\s*10/);
    expect(src).toMatch(/FRESH_APPEAR_COUNT_MAX\s*=\s*7/);
  });

  it("keyword.last_recommended_at UPDATE 在入队后执行", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/recommendation/daily-cron.ts", import.meta.url),
      "utf8",
    );
    // createBatch 在 UPDATE 之前
    const batchIdx = src.indexOf("createBatch(");
    const updateIdx = src.indexOf("lastRecommendedAt: new Date()");
    expect(batchIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(batchIdx);
  });
});

describe("PR #172: schema.ts keywords.lastRecommendedAt", () => {
  it("keywords 表含 lastRecommendedAt 字段", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../models/schema.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/lastRecommendedAt.*timestamp.*last_recommended_at/);
  });
});

describe("PR #172: migrate.ts 含 ALTER TABLE keywords ADD last_recommended_at", () => {
  it("含幂等 ALTER + index", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../models/migrate.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/ALTER TABLE keywords ADD COLUMN last_recommended_at/);
    expect(src).toMatch(/idx_kw_last_recommended/);
  });
});

describe("PR #172: selectCandidates 候选池逻辑", () => {
  it("selectCandidates 函数存在且含学科过滤 + cooldown 条件", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/recommendation/daily-cron.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/async function selectCandidates/);
    expect(src).toMatch(/cooldownDays/);
    expect(src).toMatch(/disciplines/);
    expect(src).toMatch(/category/);
  });
});
