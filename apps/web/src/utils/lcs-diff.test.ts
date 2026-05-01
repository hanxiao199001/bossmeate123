/** task #20 T4-2-2: lcs-diff 行级 diff 单测。 */
import { describe, it, expect } from "vitest";
import { diffLines } from "./lcs-diff";

describe("diffLines (LCS line-level)", () => {
  it("identical inputs → all 'same'", () => {
    const segs = diffLines("a\nb\nc", "a\nb\nc");
    expect(segs.every((s) => s.type === "same")).toBe(true);
    expect(segs.map((s) => s.text)).toEqual(["a", "b", "c"]);
  });

  it("pure addition at end", () => {
    const segs = diffLines("a\nb", "a\nb\nc");
    expect(segs).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "added", text: "c" },
    ]);
  });

  it("pure removal in middle", () => {
    const segs = diffLines("a\nb\nc", "a\nc");
    expect(segs.map((s) => `${s.type}:${s.text}`)).toEqual(["same:a", "removed:b", "same:c"]);
  });

  it("replacement (1 removed + 1 added in same position)", () => {
    const segs = diffLines("a\nB\nc", "a\nx\nc");
    const types = segs.map((s) => s.type);
    expect(types).toContain("removed");
    expect(types).toContain("added");
    expect(types.filter((t) => t === "same")).toHaveLength(2);
  });

  it("empty original → all added", () => {
    const segs = diffLines("", "a\nb");
    // 注意："" split → [""]，所以会有 1 个空 same 行（边界保留 OK）
    const added = segs.filter((s) => s.type === "added");
    expect(added.map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("empty rewritten → all removed", () => {
    const segs = diffLines("a\nb", "");
    const removed = segs.filter((s) => s.type === "removed");
    expect(removed.map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("both empty → single same empty", () => {
    expect(diffLines("", "")).toEqual([{ type: "same", text: "" }]);
  });

  it("Chinese content diff", () => {
    const original = "## 标题\n这是原文一行。\n这是原文二行。";
    const rewritten = "## 标题\n这是新文一行。\n这是原文二行。";
    const segs = diffLines(original, rewritten);
    expect(segs.find((s) => s.type === "removed" && s.text === "这是原文一行。")).toBeDefined();
    expect(segs.find((s) => s.type === "added" && s.text === "这是新文一行。")).toBeDefined();
    expect(segs.filter((s) => s.type === "same").length).toBe(2);
  });
});
