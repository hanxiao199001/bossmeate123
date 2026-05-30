/**
 * PR-D — DB 版本化迁移机制 file-content 回归。
 * 验: schema_migrations 追踪 + 只跑未应用 + 事务包裹 + 首条核心索引存在。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR-D: 版本化迁移", () => {
  it("migrate.ts: schema_migrations 追踪 + 只跑 pending + 事务", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/schema_migrations/);
    expect(src).toMatch(/MIGRATIONS\.filter\(\(m\) => !applied\.has\(m\.version\)\)/);
    expect(src).toMatch(/INSERT INTO schema_migrations/);
    expect(src).toMatch(/"BEGIN"/);
    expect(src).toMatch(/"ROLLBACK"/);
    expect(src).toMatch(/runTrackedMigrations\(client, false\)/); // 真实分支接入
  });
  it("migrations.ts: 首条核心筛选索引", async () => {
    const src = await readSrc("../models/migrations.ts");
    expect(src).toMatch(/001_journals_core_indexes/);
    expect(src).toMatch(/USING gin \(catalogs\)/);
    expect(src).toMatch(/export const MIGRATIONS: Migration\[\]/);
  });
});
