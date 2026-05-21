/**
 * 5-20 PR #193 — backfill-discipline 重推 multidisciplinary 错标. file-content regression.
 *   根因: 候选只选 discipline IS NULL, 错标 multidisciplinary 的不重推.
 *   修: 候选加 'multidisciplinary', enrich 补 jcr_full 后重推修正 (IEEE Automation→engineering).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #193: backfill-discipline 重推 multidisciplinary", () => {
  it("候选条件加 discipline='multidisciplinary'", async () => {
    const src = await readSrc("../scripts/backfill-discipline.ts");
    expect(src).toMatch(/eq\(journals\.discipline, "multidisciplinary"\)/);
  });
  it("优先 jcr_full 推断 (mapSubjectToDiscipline 含 autom→engineering)", async () => {
    const src = await readSrc("../scripts/backfill-discipline.ts");
    expect(src).toMatch(/inferDisciplineFromJCR/);
    expect(src).toMatch(/autom\|manufactur/); // engineering 分支含 autom
  });
  it("真 multidisc 安全 (subject=Multidisciplinary 重判回)", async () => {
    const src = await readSrc("../scripts/backfill-discipline.ts");
    expect(src).toMatch(/multidisciplinary\|general\|interdisciplinary/);
  });
});
