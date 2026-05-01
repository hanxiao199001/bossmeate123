/**
 * B.4-1: CSCD + 北大核心目录 ingest 单测。
 * 校验 enum / matched 计数 / dry-run / COALESCE 不覆盖 / 真实 seed 合法。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const { validateMapping, ingest } = await import("../scripts/ingest-cscd-pku.js");
const { CSCD_PKU_MAPPING } = await import("../data/cscd-pku-mapping.js");

const META = { cscdSource: "x", pkuSource: "y", lastUpdatedAt: "z" };

function fakeClient(matches: Map<string, number>): any {
  return {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith("SELECT id FROM journals")) {
        const count = matches.get(params[0] as string) ?? 0;
        return { rowCount: count, rows: Array.from({ length: count }, (_, i) => ({ id: `j-${i}` })) };
      }
      if (sql.startsWith("UPDATE journals")) {
        return { rowCount: matches.get(params[2] as string) ?? 0 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  };
}

describe("ingest-cscd-pku", () => {
  it("validateMapping: 非法 cscdLevel / pkuCoreLevel → 抛错", () => {
    expect(() => validateMapping({ meta: META, mappings: { "0376-2491": { cscdLevel: "随便编的" } } } as any)).toThrow(/非法 cscdLevel/);
    expect(() => validateMapping({ meta: META, mappings: { "0376-2491": { pkuCoreLevel: "钦定核心" } } } as any)).toThrow(/非法 pkuCoreLevel/);
  });

  it("real seed CSCD_PKU_MAPPING ≥20 entries 全部合法", () => {
    expect(Object.keys(CSCD_PKU_MAPPING.mappings).length).toBeGreaterThanOrEqual(20);
    expect(() => validateMapping(CSCD_PKU_MAPPING)).not.toThrow();
  });

  it("ingest: ISSN 命中跨 tenant + 收集 unmatched", async () => {
    const matches = new Map([["0376-2491", 2], ["1671-167X", 1]]);
    const stats = await ingest(fakeClient(matches), {
      meta: META,
      mappings: {
        "0376-2491": { pkuCoreLevel: "北大核心" },
        "1671-167X": { cscdLevel: "扩展库" },
        "9999-9999": { pkuCoreLevel: "北大核心" },
      },
    } as any);
    expect(stats).toMatchObject({ totalMappings: 3, matched: 3, updated: 3, unmatched: ["9999-9999"] });
  });

  it("dry-run: 跳过 UPDATE 但仍统计 matched", async () => {
    const client = fakeClient(new Map([["0376-2491", 1]]));
    const stats = await ingest(client, { meta: META, mappings: { "0376-2491": { pkuCoreLevel: "北大核心" } } } as any, true);
    expect(stats).toMatchObject({ matched: 1, updated: 0 });
    expect(client.query).toHaveBeenCalledTimes(1); // SELECT only
  });

  it("UPDATE 用 COALESCE 不覆盖已有值（仅显式给的字段才写）", async () => {
    const client = fakeClient(new Map([["0376-2491", 1]]));
    await ingest(client, { meta: META, mappings: { "0376-2491": { pkuCoreLevel: "北大核心" } } } as any);
    const updateCall = client.query.mock.calls.find((c: any) => c[0].includes("UPDATE"));
    expect(updateCall[1]).toEqual([null, "北大核心", "0376-2491"]); // cscdLevel=null → COALESCE 保留
  });
});
