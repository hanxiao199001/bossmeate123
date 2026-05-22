/**
 * 5-22 PR #203 — 新增编辑型板块 (全用已有可信字段派生, 零准确性风险):
 *  适合人群画像 / 投稿时间线 / 同档期刊对比 (避坑清单沿用已有区块 19).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/publisher/adapters/shunshi-style-template.ts";
const COLLECTOR = "../services/data-collection/journal-content-collector.ts";

describe("PR #203: 适合人群画像", () => {
  it("有 renderTargetAudienceBlock 且按 IF/录用率/版面费/预警 派生", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderTargetAudienceBlock/);
    expect(src).toMatch(/👥 适合人群/);
    expect(src).toMatch(/谨慎评估/);
  });
  it("无可派生项时整块 skip", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/if \(fit\.length === 0 && careful\.length === 0\) return "";/);
  });
});

describe("PR #203: 投稿时间线", () => {
  it("有 renderTimelineBlock, 锚定审稿周期", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderTimelineBlock/);
    expect(src).toMatch(/🗓️ 投稿时间线/);
    expect(src).toMatch(/if \(!rc\) return "";/); // 无审稿周期不渲染 (不编造)
  });
});

describe("PR #203: 同档期刊对比", () => {
  it("collector 查同分区/同学科 IF 相近 peers", async () => {
    const src = await readSrc(COLLECTOR);
    expect(src).toMatch(/peerJournals/);
    expect(src).toMatch(/eq\(journals\.casPartition, \(journal as any\)\.casPartition\)/);
    expect(src).toMatch(/ne\(journals\.id, journal\.id\)/);
    expect(src).toMatch(/isNotNull\(journals\.impactFactor\)/);
  });
  it("render 块用可信字段, 无 peer 则 skip", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/function renderPeerComparisonBlock/);
    expect(src).toMatch(/📋 同档期刊对比/);
    expect(src).toMatch(/if \(!peers \|\| peers\.length === 0\) return "";/);
  });
});

describe("PR #203: 四块都接入渲染流", () => {
  it("section 列表含三个新块", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/renderTargetAudienceBlock\(journal\)/);
    expect(src).toMatch(/renderTimelineBlock\(journal\)/);
    expect(src).toMatch(/renderPeerComparisonBlock\(journal\)/);
  });
});
