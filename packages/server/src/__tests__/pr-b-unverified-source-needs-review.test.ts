/**
 * PR B: daily-cron 回退选中未核实源刊(conf<70/legacy_unknown) → 内容标 needs_review。
 * 走 PR#200 发布期硬闸 + 工坊人工复核后才对外。国际 scope 结构上不回退(legacy_intl_reachable=0)。
 */
import { describe, it, expect } from "vitest";
import { isUnverifiedJournal } from "../services/journals/verification.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("isUnverifiedJournal — 单一事实源(verification.ts)", () => {
  it("legacy_unknown / conf<70 → 未核实; conf≥70 multi → 已核实", () => {
    expect(isUnverifiedJournal({ confidence: 50, dataSource: "legacy_unknown" })).toBe(true);
    expect(isUnverifiedJournal({ confidence: 60, dataSource: "letpub_only" })).toBe(true); // conf<70 国际刊也算
    expect(isUnverifiedJournal({ confidence: 70, dataSource: "multi_source_verified" })).toBe(false);
    expect(isUnverifiedJournal({ confidence: 95, dataSource: "legacy_unknown" })).toBe(true); // legacy 即便高 conf
  });
});

describe("PR B wire — batch-worker 未核实源转 needs_review", () => {
  it("系统租户 + 未核实源 → titleBodyBad reason=unverified_source_journal", async () => {
    const src = await readSrc("../services/batch/batch-worker.ts");
    expect(src).toMatch(/tenantId === SYSTEM_RECOMMENDATION_TENANT_ID && isUnverifiedJournal\(jr\)/);
    expect(src).toMatch(/reason: "unverified_source_journal"/);
  });

  it("未核实源判定排在编造/矛盾检查之后(优先级: 编造>矛盾>未核实源)", async () => {
    const src = await readSrc("../services/batch/batch-worker.ts");
    const fabricatedIdx = src.indexOf('"title_data_fabricated"');
    const unverifiedIdx = src.indexOf('"unverified_source_journal"');
    expect(fabricatedIdx).toBeGreaterThan(-1);
    expect(unverifiedIdx).toBeGreaterThan(-1);
    expect(fabricatedIdx).toBeLessThan(unverifiedIdx); // else-if 链: 编造在前, 未核实源兜底
    // 且它经由既有 needs_review 机制(titleBodyBad → transitionStatus needs_review + needsReviewReason)
    expect(src).toMatch(/needsReviewReason: titleBodyBad\.reason/);
  });

  it("单一事实源: kf-responder + batch-worker 都从 verification.js import", async () => {
    const kf = await readSrc("../services/work-wechat/kf-responder.ts");
    const bw = await readSrc("../services/batch/batch-worker.ts");
    expect(kf).toMatch(/from "\.\.\/journals\/verification\.js"/);
    expect(bw).toMatch(/from "\.\.\/journals\/verification\.js"/);
  });
});
