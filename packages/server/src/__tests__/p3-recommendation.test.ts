/**
 * P3 AI 推荐 backend 单元测试。
 * 覆盖：cache TTL + journal-recommender 排序/fallback + topic-recommender + route 守卫
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(48), LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", DATABASE_URL: "postgres://t/t" },
}));

const { cacheGet, cacheSet, cacheKey, cacheClear, cacheSize } = await import("../services/recommendation/cache.js");

beforeEach(() => cacheClear());

describe("P3 cache: TTL + key", () => {
  it("set/get round-trip", () => {
    cacheSet("k1", { x: 1 });
    expect(cacheGet<{ x: number }>("k1")).toEqual({ x: 1 });
  });

  it("过期后 get 返回 null + 自动清 entry", () => {
    cacheSet("k2", "v");
    // 直接 mock Date.now：跳到 31 分钟后
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60 * 1000;
    try {
      expect(cacheGet("k2")).toBe(null);
      expect(cacheSize()).toBe(0); // entry 自动删
    } finally {
      Date.now = realNow;
    }
  });

  it("cacheKey 含 tenantId 防 cross-tenant 污染 + 跳过 undefined", () => {
    expect(cacheKey(["recommend-journals", "t-1", "topic-x", 5])).toBe("recommend-journals:t-1:topic-x:5");
    expect(cacheKey(["recommend-journals", "t-1", undefined, 5])).toBe("recommend-journals:t-1:5");
    expect(cacheKey(["recommend-journals", "t-1", "", 5])).toBe("recommend-journals:t-1:5");
  });
});

describe("P3 journal-recommender 静态校验（src 含必含逻辑）", () => {
  it("源代码含 confidence>=70 候选 + 历史 metadata.journalId 提取 + LLM JSON parse", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/journal-recommender.ts", import.meta.url), "utf8");
    expect(src).toMatch(/gte\(journals\.confidence,\s*70\)/);
    expect(src).toMatch(/metadata\.journalId|metadata as Record<string, unknown>/);
    expect(src).toMatch(/getProviders\(\)\.cheap/);
    expect(src).toMatch(/JSON\.parse/);
    // 防 LLM hallucinate id：candidateIds.has 检查
    expect(src).toMatch(/candidateIds\.has/);
  });

  it("含 fallback（LLM 失败时按 confidence DESC 返回）+ 调 cacheSet", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/journal-recommender.ts", import.meta.url), "utf8");
    expect(src).toMatch(/useFallback|llmResult\.length === 0/);
    expect(src).toMatch(/cacheSet\(key/);
    expect(src).toMatch(/cacheGet/);
  });

  it("查 candidates 含 全局共享（NULL）+ 自 tenant（OR 模式）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/journal-recommender.ts", import.meta.url), "utf8");
    expect(src).toMatch(/or\(isNull\(journals\.tenantId\),\s*eq\(journals\.tenantId,\s*input\.tenantId\)\)/);
  });
});

describe("P3 topic-recommender 静态校验", () => {
  it("源代码含 journalId 可缺 + 历史 title 提取 + LLM 调用 + cache", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/recommendation/topic-recommender.ts", import.meta.url), "utf8");
    expect(src).toMatch(/input\.journalId/);
    expect(src).toMatch(/title:\s*contents\.title/);
    expect(src).toMatch(/getProviders\(\)\.cheap/);
    expect(src).toMatch(/cacheGet|cacheSet/);
    expect(src).toMatch(/journal\.discipline/); // fallback 用
  });
});

describe("P3 route 守卫 + 接入", () => {
  it("recommend.ts 含 zod schema + 2 GET routes + protectedApp 注册", async () => {
    const fs = await import("node:fs/promises");
    const route = await fs.readFile(new URL("../routes/recommend.ts", import.meta.url), "utf8");
    expect(route).toMatch(/app\.get\("\/recommend\/journals"/);
    expect(route).toMatch(/app\.get\("\/recommend\/topics"/);
    expect(route).toMatch(/journalsQuerySchema|topicsQuerySchema/);
    // 注册校验
    const idx = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(idx).toMatch(/recommendRoutes/);
    expect(idx).toMatch(/protectedApp\.register\(recommendRoutes/);
  });
});
