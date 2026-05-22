/**
 * 5-22 PR #212 — jcarindex CAR 抓取脚本回归.
 * 验证: 接口/参数/绕403头/限速/CAR字段映射/provenance/test模式 都在.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-jcar-car.ts";

describe("PR #212: jcarindex 接口 + 绕 403", () => {
  it("用确认的公开接口 + 按 ISSN 查", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/\/ifs\/public\/jcar\/getJournalList/);
    expect(src).toMatch(/issn=\$\{encodeURIComponent\(issn\)\}/);
  });
  it("带 referer + UA (之前吃 403 的根因) + session bootstrap", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/referer: `\$\{BASE\}\/`/);
    expect(src).toMatch(/"user-agent": UA/);
    expect(src).toMatch(/function bootstrapSession/);
    expect(src).toMatch(/JSESSIONID=/);
  });
  it("礼貌限速 ≥800ms + 错误退避", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/await sleep\(800\)/);
    expect(src).toMatch(/await sleep\(2000\)/);
  });
  it("--limit 小批验证模式", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/--limit/);
  });
});

describe("PR #212: CAR 字段映射 + 写库", () => {
  it("carIndex 三年 → car_index_history.data", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/carIndexBeforeLastYear[\s\S]{0,80}?JCAR_LATEST_YEAR - 2/);
    expect(src).toMatch(/carIndexLastYear[\s\S]{0,80}?JCAR_LATEST_YEAR - 1/);
    expect(src).toMatch(/carIndex[\s\S]{0,80}?JCAR_LATEST_YEAR, carIndex/);
  });
  it("sciRiskRank 低/中/高 → low/mid/high", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/if \(rank === "高"\) return "high"/);
    expect(src).toMatch(/if \(rank === "中"\) return "mid"/);
  });
  it("写 carIndexHistory + provenance=jcarindex", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/carIndexHistory: carHist/);
    expect(src).toMatch(/"carIndexHistory":"jcarindex"/);
  });
  it("保留 growthRate + 问题文章数 (jcarindex 额外硬信号)", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/growthRate/);
    expect(src).toMatch(/problemArticles/);
  });
});
