/**
 * PR B.14：collector ORDER BY 0 hotfix 防回归测试。
 *
 * 旧代码 `: sql\`0\`` 在无 issnMatch 时渲染成 `ORDER BY 0`，PG 视为 position 0
 * （select list 从 1 起）→ DatabaseError "ORDER BY position 0 is not in select list"。
 * pm2 logs 5-1~5-5 见此错误 11+ 次。本测试 grep 源码确保不再含 `sql\`0\``。
 */
import { describe, it, expect } from "vitest";

describe("PR B.14: ORDER BY 0 防回归", () => {
  it("collector 源码不再含 sql`0`（PG ORDER BY position 0 错误源）", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL(
      "../services/data-collection/journal-content-collector.ts",
      import.meta.url,
    );
    const src = await fs.readFile(url, "utf8");
    expect(src).not.toMatch(/:\s*sql`0`/);
    expect(src).not.toMatch(/orderBy\([^)]*sql`0`/s);
  });
});
