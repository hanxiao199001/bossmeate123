import { describe, it, expect } from "vitest";
import { diffJsonb } from "./diff-jsonb";

describe("diffJsonb", () => {
  it("scalar change", () => {
    const d = diffJsonb({ apc: 100 }, { apc: 200 });
    expect(d).toEqual([{ path: "apc", type: "changed", before: 100, after: 200 }]);
  });

  it("scalar same omitted by default", () => {
    expect(diffJsonb({ apc: 100 }, { apc: 100 })).toEqual([]);
  });

  it("includeSame returns same entries", () => {
    const d = diffJsonb({ apc: 100 }, { apc: 100 }, { includeSame: true });
    expect(d.find((e) => e.path === "apc")?.type).toBe("same");
  });

  it("added key", () => {
    const d = diffJsonb({}, { currency: "USD" });
    expect(d).toEqual([{ path: "currency", type: "added", after: "USD" }]);
  });

  it("removed key", () => {
    const d = diffJsonb({ currency: "USD" }, {});
    expect(d).toEqual([{ path: "currency", type: "removed", before: "USD" }]);
  });

  it("null vs missing not treated as diff", () => {
    expect(diffJsonb({ apc: null }, {})).toEqual([]);
    expect(diffJsonb({}, { apc: null })).toEqual([]);
  });

  it("nested object change", () => {
    const d = diffJsonb(
      { predicted: { year: 2024, if: 5.1 } },
      { predicted: { year: 2024, if: 5.5 } },
    );
    expect(d).toEqual([{ path: "predicted.if", type: "changed", before: 5.1, after: 5.5 }]);
  });

  it("array element change uses [i] index path", () => {
    const d = diffJsonb(
      { data: [{ year: 2023, if: 4.0 }, { year: 2024, if: 5.0 }] },
      { data: [{ year: 2023, if: 4.0 }, { year: 2024, if: 5.5 }] },
    );
    expect(d).toEqual([{ path: "data[1].if", type: "changed", before: 5.0, after: 5.5 }]);
  });

  it("array length grow → added entries", () => {
    const d = diffJsonb({ tags: ["a"] }, { tags: ["a", "b"] });
    expect(d).toEqual([{ path: "tags[1]", type: "added", after: "b" }]);
  });

  it("array length shrink → removed entries", () => {
    const d = diffJsonb({ tags: ["a", "b"] }, { tags: ["a"] });
    expect(d).toEqual([{ path: "tags[1]", type: "removed", before: "b" }]);
  });

  it("type mismatch counts as change", () => {
    const d = diffJsonb({ x: "1" }, { x: 1 });
    expect(d[0]).toMatchObject({ path: "x", type: "changed" });
  });

  it("multiple changes sorted by path", () => {
    const d = diffJsonb({ a: 1, b: 2 }, { a: 10, b: 20 });
    expect(d.map((e) => e.path)).toEqual(["a", "b"]);
  });
});
