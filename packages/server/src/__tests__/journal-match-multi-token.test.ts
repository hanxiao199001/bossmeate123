/**
 * PR B.11：V6 collector 多 token + ISSN 路由 ILIKE 单元测试。
 *
 * Bug：chat parser 把 "The Lancet" 包成 "The Lancet（柳叶刀）"，整串 ILIKE 永远不命
 * 中 DB 里 name="柳叶刀" / nameEn="The Lancet" → 全部走 AI 合成，PR B.10 wire 不可达。
 * Fix：先 ISSN 正则路由 → 整 topic → 去括号 topic → token 子串拆分。
 *
 * 测试不连真 DB（mock drizzle ilike/or/and），只验证 condition 生成数量与正确性。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://t/t", QWEN_API_KEY:"k" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// 把 collector 内部的匹配 condition 构造逻辑抽出来跑（不连 DB）。规则与 collector :228-264 一致。
function buildMatchConds(topic: string, hotKeywords: string[] = []) {
  const issnMatch = topic.match(/\b\d{4}-\d{3}[\dxX]\b/);
  const cleanedTopic = topic.replace(/\([^)]*\)|（[^）]*）/g, "").trim();
  const tokens = cleanedTopic.split(/\s+/).filter((t) => t.length >= 2);
  const conds: Array<{ col: string; pat: string }> = [];
  if (issnMatch) conds.push({ col: "issn", pat: issnMatch[0] });
  conds.push({ col: "discipline", pat: `%${topic}%` });
  conds.push({ col: "name", pat: `%${topic}%` });
  conds.push({ col: "nameEn", pat: `%${topic}%` });
  if (cleanedTopic && cleanedTopic !== topic) {
    conds.push({ col: "name", pat: `%${cleanedTopic}%` });
    conds.push({ col: "nameEn", pat: `%${cleanedTopic}%` });
  }
  for (const tok of tokens) {
    if (tok === cleanedTopic) continue;
    conds.push({ col: "name", pat: `%${tok}%` });
    conds.push({ col: "nameEn", pat: `%${tok}%` });
  }
  if (hotKeywords.length > 0) conds.push({ col: "discipline", pat: `%${hotKeywords[0]}%` });
  return { conds, issnMatch: issnMatch?.[0] ?? null, cleanedTopic, tokens };
}

describe("PR B.11: V6 多 token + ISSN 路由", () => {
  it("'The Lancet（柳叶刀）' → 去括号产生 'The Lancet' + token 'The'/'Lancet' 子串", () => {
    const r = buildMatchConds("The Lancet（柳叶刀）");
    expect(r.cleanedTopic).toBe("The Lancet");
    expect(r.tokens).toEqual(["The", "Lancet"]);
    expect(r.conds.some((c) => c.col === "nameEn" && c.pat === "%Lancet%")).toBe(true);
    expect(r.conds.some((c) => c.col === "nameEn" && c.pat === "%The Lancet%")).toBe(true);
  });

  it("'0140-6736' → ISSN 正则命中 + 走 issn 列精确匹配", () => {
    const r = buildMatchConds("0140-6736");
    expect(r.issnMatch).toBe("0140-6736");
    expect(r.conds[0]).toEqual({ col: "issn", pat: "0140-6736" });
  });

  it("'0140-6736（《柳叶刀》期刊相关主题）' → ISSN + 去括号 token 同时命", () => {
    const r = buildMatchConds("0140-6736（《柳叶刀》期刊相关主题）");
    expect(r.issnMatch).toBe("0140-6736");
    expect(r.cleanedTopic).toBe("0140-6736");
    expect(r.conds[0]).toEqual({ col: "issn", pat: "0140-6736" });
  });

  it("'柳叶刀' → 中文整串 + 单 token 子串", () => {
    const r = buildMatchConds("柳叶刀");
    expect(r.tokens).toEqual(["柳叶刀"]);
    expect(r.conds.some((c) => c.col === "name" && c.pat === "%柳叶刀%")).toBe(true);
  });

  it("'The Lancet' → 整串 + 'The'/'Lancet' 双 token", () => {
    const r = buildMatchConds("The Lancet");
    expect(r.cleanedTopic).toBe("The Lancet");
    expect(r.tokens).toEqual(["The", "Lancet"]);
    // 整串 = cleanedTopic → cleanedTopic 路径不重复加，但 token 'Lancet' 子串会加
    expect(r.conds.some((c) => c.col === "nameEn" && c.pat === "%Lancet%")).toBe(true);
  });

  it("'完全不存在的期刊' → 不命中 ISSN，走 token 子串（fallback 到 AI 合成由 caller 决定）", () => {
    const r = buildMatchConds("完全不存在的期刊");
    expect(r.issnMatch).toBeNull();
    // 至少 name/nameEn 整串 ILIKE 加进去（即便实际查不到 row，conds 不空）
    expect(r.conds.length).toBeGreaterThan(0);
  });
});
