import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../services/publisher/adapters/wechat-article-template.js", () => ({
  generateWechatJournalArticleHtml: vi.fn(async () => "<html>mocked</html>"),
}));
vi.mock("../services/publisher/adapters/storytelling-template.js", () => ({
  generateStorytellingHtml: vi.fn(async () => "<html>storytelling-mock</html>"),
}));
vi.mock("../services/publisher/adapters/listicle-template.js", () => ({
  generateListicleHtml: vi.fn(async () => "<html>listicle-mock</html>"),
}));

// Mock drizzle db chain — query 1 (selectedRows) and query 2 (rejectedRaw)
// share the same .select().from().where().groupBy() / .where() chain. We use
// a counter to flip behavior between the two queries within a single test.
let dbCallSeq: Array<unknown[]> = [];
let dbCallIdx = 0;

vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const obj = {
            groupBy: () => {
              const rows = dbCallSeq[dbCallIdx++] ?? [];
              return Promise.resolve(rows);
            },
            then: (resolve: any) => {
              const rows = dbCallSeq[dbCallIdx++] ?? [];
              return Promise.resolve(rows).then(resolve);
            },
          };
          return obj;
        },
      }),
    }),
  },
}));

vi.mock("../models/schema.js", () => ({
  bossEdits: {
    tenantId: "tenant_id-col",
    action: "action-col",
    patternsExtracted: "patterns_extracted-col",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => "eq-stub",
  and: () => "and-stub",
  // sql template — return a stub object with .as()
  sql: Object.assign(
    (..._args: unknown[]) => ({ as: () => ({}) }),
    { raw: () => ({}) }
  ),
}));

const {
  getTemplatePreferences,
  selectVariantTemplates,
  clearTemplatePreferenceCache,
} = await import("../services/skills/template-preference.js");

beforeEach(() => {
  dbCallSeq = [];
  dbCallIdx = 0;
  clearTemplatePreferenceCache();
});

describe("getTemplatePreferences", () => {
  it("returns empty array for empty tenantId without hitting db", async () => {
    const prefs = await getTemplatePreferences("");
    expect(prefs).toEqual([]);
    expect(dbCallIdx).toBe(0);
  });

  it("returns weights normalized over selectedCount sum", async () => {
    // query 1 (selected): storytelling=8, listicle=2 → totalSelected=10
    // query 2 (rejected raw): one row with rejectedTemplateIds=["data-card"]
    dbCallSeq = [
      [
        { tid: "storytelling", cnt: 8 },
        { tid: "listicle", cnt: 2 },
      ],
      [{ rejected: ["data-card"] }],
    ];

    const prefs = await getTemplatePreferences("tenant-A");
    const story = prefs.find((p) => p.templateId === "storytelling")!;
    const list = prefs.find((p) => p.templateId === "listicle")!;
    const card = prefs.find((p) => p.templateId === "data-card");

    expect(story.selectedCount).toBe(8);
    expect(story.weight).toBeCloseTo(0.8, 5);
    expect(list.selectedCount).toBe(2);
    expect(list.weight).toBeCloseTo(0.2, 5);
    expect(card?.rejectedCount).toBe(1);
    expect(card?.selectedCount).toBe(0);
    expect(card?.weight).toBe(0);
  });

  it("second call within TTL hits cache (db query count unchanged)", async () => {
    dbCallSeq = [[{ tid: "storytelling", cnt: 1 }], []];
    await getTemplatePreferences("tenant-cache");
    const idxAfterFirst = dbCallIdx;

    await getTemplatePreferences("tenant-cache");
    expect(dbCallIdx).toBe(idxAfterFirst); // no extra query
  });
});

describe("selectVariantTemplates", () => {
  it("variants=1 returns [defaultId]", async () => {
    const ids = await selectVariantTemplates("tenant-X", 1);
    expect(ids).toEqual(["data-card"]);
  });

  it("variants=2 with empty preferences returns [defaultId, oneOfNonDefault]", async () => {
    dbCallSeq = [[], []];
    const ids = await selectVariantTemplates("tenant-empty", 2, {
      random: () => 0, // pick first remaining candidate
    });
    expect(ids[0]).toBe("data-card");
    expect(ids[1]).not.toBe("data-card");
    expect(["storytelling", "listicle"]).toContain(ids[1]);
  });

  it("variants=3 returns 3 distinct ids: default + two non-default", async () => {
    dbCallSeq = [[], []];
    const ids = await selectVariantTemplates("tenant-empty-3", 3, {
      random: () => 0,
    });
    expect(ids[0]).toBe("data-card");
    expect(new Set(ids).size).toBe(3);
    expect(ids.slice(1).sort()).toEqual(["listicle", "storytelling"]);
  });

  it("concentrated preference (storytelling weight=1.0) → r=0.0 picks storytelling", async () => {
    dbCallSeq = [[{ tid: "storytelling", cnt: 10 }], []];
    const ids = await selectVariantTemplates("tenant-pref", 2, {
      random: () => 0, // r=0 lands on first weighted candidate
    });
    expect(ids[0]).toBe("data-card");
    expect(ids[1]).toBe("storytelling");
  });

  it("respects defaultId override (storytelling as primary)", async () => {
    dbCallSeq = [[], []];
    const ids = await selectVariantTemplates("tenant-override", 2, {
      defaultId: "storytelling",
      random: () => 0,
    });
    expect(ids[0]).toBe("storytelling");
    expect(ids[1]).not.toBe("storytelling");
  });

  it("variants > available non-default+1 → fills remainder with defaultId", async () => {
    dbCallSeq = [[], []];
    // 4 templates registered (data-card default + 3 non-defaults). variants=6
    // → [default, nd1, nd2, nd3, default, default]
    const ids = await selectVariantTemplates("tenant-overflow", 6, {
      random: () => 0,
    });
    expect(ids.length).toBe(6);
    expect(ids[0]).toBe("data-card");
    // 3 non-default picks all distinct
    expect(new Set(ids.slice(1, 4)).size).toBe(3);
    // remaining slots filled by defaultId
    expect(ids[4]).toBe("data-card");
    expect(ids[5]).toBe("data-card");
  });
});
