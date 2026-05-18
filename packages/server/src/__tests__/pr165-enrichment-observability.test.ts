/**
 * 5-23 PR #165a + #165b — enrichment 观察 (0 风险) 防回归.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #165: enrichment observability (field_provenance + log)", () => {
  it("migrate.ts: journal_enrichment_log 表 + 4 indexes", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS journal_enrichment_log/);
    expect(src).toMatch(/idx_jel_journal/);
    expect(src).toMatch(/idx_jel_source/);
    expect(src).toMatch(/idx_jel_status/);
    expect(src).toMatch(/idx_jel_attempted/);
    // 字段
    expect(src).toMatch(/source VARCHAR\(20\) NOT NULL/);
    expect(src).toMatch(/status VARCHAR\(20\) NOT NULL/); // success/failed/timeout/skipped
    expect(src).toMatch(/fields_written JSONB/);
    expect(src).toMatch(/duration_ms INTEGER/);
  });

  it("schema.ts: journalEnrichmentLog drizzle table", async () => {
    const src = await readSrc("../models/schema.ts");
    expect(src).toMatch(/export const journalEnrichmentLog\s*=\s*pgTable\(/);
    expect(src).toMatch(/fieldsWritten:\s*jsonb\("fields_written"\)/);
    expect(src).toMatch(/durationMs:\s*integer\("duration_ms"\)/);
  });

  it("orchestrator.ts: timed() helper 包每源 + per-source log 写入", async () => {
    const src = await readSrc("../services/journal-enricher/orchestrator.ts");
    // timed helper
    expect(src).toMatch(/async function timed/);
    expect(src).toMatch(/status:\s*"success"\s*\|\s*"failed"\s*\|\s*"timeout"/);
    // 每源 wrap
    expect(src).toMatch(/timed\("letpub"/);
    expect(src).toMatch(/timed\("crossref"/);
    expect(src).toMatch(/timed\("doaj"/);
    // PR #166: scimago 已砍 — 不再 timed("scimago")
    expect(src).not.toMatch(/timed\("scimago"/);
    expect(src).toMatch(/timed\("openalex"/);
    // log INSERT
    expect(src).toMatch(/db\.insert\(journalEnrichmentLog\)\.values\(logRows\)/);
  });

  it("orchestrator.ts: realProvenance 跟踪 + 合并入 fieldProvenance", async () => {
    const src = await readSrc("../services/journal-enricher/orchestrator.ts");
    expect(src).toMatch(/const realProvenance:\s*Record<string,\s*string>\s*=\s*\{\}/);
    // 几个关键字段的来源标记
    expect(src).toMatch(/realProvenance\.ifHistory\s*=\s*"letpub"/);
    expect(src).toMatch(/realProvenance\.publisher\s*=\s*"openalex"/);
    expect(src).toMatch(/realProvenance\.publicationCosts\s*=\s*"doaj"/);
    // merge 入 fieldProvenance (realProvenance 覆盖 trust 默认)
    expect(src).toMatch(/mergedProvenance\s*=\s*\{\s*\.\.\.trust\.fieldProvenance,\s*\.\.\.realProvenance\s*\}/);
  });

  it("scripts/run-enrichment-backfill.ts: 全表跑 + 2 报告 (源命中 + 字段来源)", async () => {
    const src = await readSrc("../scripts/run-enrichment-backfill.ts");
    expect(src).toMatch(/enrichJournal\(j\.id\)/);
    expect(src).toMatch(/THROTTLE_MS/);
    // 报告 a: 源命中分布
    expect(src).toMatch(/FROM journal_enrichment_log/);
    expect(src).toMatch(/AVG\(duration_ms\)/);
    // 报告 b: 字段来源 (jsonb_each_text)
    expect(src).toMatch(/jsonb_each_text\(COALESCE\(field_provenance/);
  });

  it("0 风险: 不改 fetcher 逻辑 / 不改字段值写入", async () => {
    const src = await readSrc("../services/journal-enricher/orchestrator.ts");
    // 老 fetcher 调用方式仍存在 (经 timed() 包装但内部 fn 不变)
    expect(src).toMatch(/fetchLetpubDetail\(\{ journalName: selectQueryName/);
    expect(src).toMatch(/fetchCrossrefByIssn\(journal\.issn\)/);
    // computeTrust 仍调 (confidence 不动)
    expect(src).toMatch(/computeTrust\(\{/);
    // updates 仍写 journals.set({...updates,...trustUpdate,...})
    expect(src).toMatch(/\.set\(\{\s*\.\.\.updates,\s*\.\.\.trustUpdate/);
  });
});
