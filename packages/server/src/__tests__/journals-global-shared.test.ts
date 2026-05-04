/**
 * PR B.12：journals 全局共享 reference data 可见性测试。
 *
 * collector :231 WHERE 条件 `or(isNull(tenantId), eq(tenantId, currentTenant))` 的纯
 * 逻辑复刻：global（tenantId=null）所有 tenant 共享，custom 仅本 tenant 可见，
 * 跨 tenant custom 不漏。
 */
import { describe, it, expect } from "vitest";

interface Row { id: string; tenantId: string | null; name: string }
function visible(rows: Row[], currentTenant: string): Row[] {
  return rows.filter((r) => r.tenantId === null || r.tenantId === currentTenant);
}

const TA = "tenant-aaa";
const TB = "tenant-bbb";

describe("PR B.12: journals tenant 可见性", () => {
  it("global journal (tenantId=null) 对任意 tenant 可见", () => {
    const rows: Row[] = [{ id: "g1", tenantId: null, name: "The Lancet" }];
    expect(visible(rows, TA).map((r) => r.id)).toEqual(["g1"]);
    expect(visible(rows, TB).map((r) => r.id)).toEqual(["g1"]);
  });

  it("tenant 自定义期刊只对该 tenant 可见", () => {
    const rows: Row[] = [{ id: "a1", tenantId: TA, name: "A 自定义刊" }];
    expect(visible(rows, TA).map((r) => r.id)).toEqual(["a1"]);
    expect(visible(rows, TB)).toEqual([]);
  });

  it("跨 tenant 隔离：A custom 不漏给 B + global 仍正常给两边", () => {
    const rows: Row[] = [
      { id: "g1", tenantId: null, name: "Nature（global）" },
      { id: "a1", tenantId: TA, name: "A 自定义" },
      { id: "b1", tenantId: TB, name: "B 自定义" },
    ];
    expect(visible(rows, TA).map((r) => r.id).sort()).toEqual(["a1", "g1"]);
    expect(visible(rows, TB).map((r) => r.id).sort()).toEqual(["b1", "g1"]);
  });
});
