/**
 * 未核实期刊数据播报护栏（评估发现: legacy_unknown/低 conf 刊的 IF/分区/预警被当权威播报给客户）。
 * 客服 findJournal: 未核实刊(conf<70 或 legacy_unknown) → 不发数值, 走"未核实/以官网为准/转顾问"口径。
 * daily-cron 自动选刊: conf≥70 优先。
 */
import { describe, it, expect } from "vitest";
import { isUnverifiedJournal } from "../services/work-wechat/kf-responder.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("isUnverifiedJournal — 未核实期刊判定", () => {
  it("conf<70 → 未核实", () => {
    expect(isUnverifiedJournal({ confidence: 50, dataSource: "multi_source_verified" })).toBe(true);
    expect(isUnverifiedJournal({ confidence: 60, dataSource: "letpub_only" })).toBe(true);
    expect(isUnverifiedJournal({ confidence: 69, dataSource: null })).toBe(true);
  });
  it("legacy_unknown → 未核实(即便 conf 侥幸≥70)", () => {
    expect(isUnverifiedJournal({ confidence: 95, dataSource: "legacy_unknown" })).toBe(true);
  });
  it("openalex_ingest(conf 50) → 未核实", () => {
    expect(isUnverifiedJournal({ confidence: 50, dataSource: "openalex_ingest" })).toBe(true);
  });
  it("conf≥70 的多源核实刊 → 已核实(放行播报)", () => {
    expect(isUnverifiedJournal({ confidence: 71, dataSource: "multi_source_verified" })).toBe(false);
    expect(isUnverifiedJournal({ confidence: 95, dataSource: "multi_source_verified" })).toBe(false);
  });
  it("confidence null → 按未核实处理(?? 0 < 70)", () => {
    expect(isUnverifiedJournal({ confidence: null, dataSource: "multi_source_verified" })).toBe(true);
  });
});

describe("护栏 wire 防回归", () => {
  it("kf 客服: 未核实刊不进'唯一事实来源'prompt, 改走未核实转顾问", async () => {
    const src = await readSrc("../services/work-wechat/kf-responder.ts");
    expect(src).toMatch(/isUnverifiedJournal\(journal\)/);
    expect(src).toMatch(/尚未完成多源核实/);
    // 护栏必须在"唯一事实来源"systemPrompt 之前
    const guardIdx = src.indexOf("isUnverifiedJournal(journal)");
    const promptIdx = src.indexOf("唯一事实来源");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(promptIdx);
  });

  it("daily-cron 自动选刊: conf≥70 优先", async () => {
    const src = await readSrc("../services/recommendation/daily-cron.ts");
    // verified 条件存在, 且被前置到 pick 首层
    // 7-14 单一流水线: 退役 A 路后只剩 pickScopedFreshJournal 一个选择器(pickFreshJournalStrict 随 A 路删除),
    //   conf≥70 门控仍在, 断言随实现演进从 ≥2 调到 ≥1。
    const verifiedMatches = src.match(/confidence\}? >= 70|confidence >= 70/g) || [];
    expect(verifiedMatches.length).toBeGreaterThanOrEqual(1); // pickScopedFreshJournal
    // 7-21 分层收窄: disc 拆成 discExact/discOrGeneric, 首层 verified 优先语义不变(仍 active+verified+sc+学科+fresh),
    //   只是学科条件从 disc 改为 discExact(纯对口优先)。断言随实现更新, verified 前置到首层这点未变。
    expect(src).toMatch(/active, verified, sc, discExact, fresh/);
  });
});
