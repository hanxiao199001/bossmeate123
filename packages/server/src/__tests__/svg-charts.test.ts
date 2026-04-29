/**
 * SVG charts unit tests (C 阶段)
 *
 * 用 Lancet 真实 if_history (10 年) + annualVolumeHistory (11 年) 做 fixture，
 * 验证输出 SVG 关键元素 + 边界（单点 / 空数组 → 空字符串，调用方走占位）。
 *
 * 同时写 visual snapshot 文件到 __tests__/fixtures/snapshots/，PR review 时
 * 用浏览器打开直观看图（diff review 用）。
 */

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  renderIfHistoryLineChart,
  renderAnnualVolumeBarChart,
} from "../services/publisher/svg-charts/index.js";

// ===== Lancet 真实数据（来自 PR #29 deploy 后 server enrich，DB ground truth）=====
const LANCET_IF_HISTORY: ReadonlyArray<{ year: number; if: number }> = [
  { year: 2015, if: 44.002 },
  { year: 2016, if: 47.831 },
  { year: 2017, if: 53.254 },
  { year: 2018, if: 59.102 },
  { year: 2019, if: 60.392 },
  { year: 2020, if: 79.321 },
  { year: 2021, if: 202.731 },
  { year: 2022, if: 168.9 },
  { year: 2023, if: 98.4 },
  { year: 2024, if: 88.5 },
];

const LANCET_PUB_VOLUME: ReadonlyArray<{ year: number; count: number }> = [
  { year: 2014, count: 271 },
  { year: 2015, count: 309 },
  { year: 2016, count: 337 },
  { year: 2017, count: 302 },
  { year: 2018, count: 264 },
  { year: 2019, count: 275 },
  { year: 2020, count: 215 },
  { year: 2021, count: 256 },
  { year: 2022, count: 223 },
  { year: 2023, count: 218 },
  { year: 2024, count: 251 },
];

const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");

beforeAll(() => {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
});

describe("renderIfHistoryLineChart", () => {
  it("renders 10-year Lancet IF series with viewBox + polyline + 10 value labels", () => {
    const svg = renderIfHistoryLineChart(LANCET_IF_HISTORY);
    expect(svg.length).toBeGreaterThan(500);
    expect(svg).toMatch(/viewBox="0 0 600 260"/);
    expect(svg).toMatch(/<polyline /);
    expect(svg).toMatch(/<circle /);
    // 10 个数据点 → 10 个圆（marker）
    expect(svg.match(/<circle /g) || []).toHaveLength(10);
    // 含 88.5 的真实 IF 值（2024）+ 202.7 (2021 峰值)
    expect(svg).toContain("88.5");
    expect(svg).toContain("203"); // fmtValue(202.731) → 203 (≥100 整数)
    // 写 snapshot 供 PR review 直观看图
    writeFileSync(join(SNAPSHOT_DIR, "lancet-if-line.svg"), svg, "utf-8");
  });

  it("returns empty string for single-point input (caller falls back to placeholder)", () => {
    expect(renderIfHistoryLineChart([{ year: 2024, if: 88.5 }])).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(renderIfHistoryLineChart([])).toBe("");
  });

  it("filters out non-finite or zero values, returns '' if <2 valid remain", () => {
    expect(
      renderIfHistoryLineChart([
        { year: 2023, if: 0 },
        { year: 2024, if: NaN },
      ]),
    ).toBe("");
  });
});

describe("renderAnnualVolumeBarChart", () => {
  it("renders 11-year Lancet pub volume with 11 rect bars + viewBox", () => {
    const svg = renderAnnualVolumeBarChart(LANCET_PUB_VOLUME);
    expect(svg.length).toBeGreaterThan(500);
    expect(svg).toMatch(/viewBox="0 0 600 260"/);
    expect(svg).toMatch(/<rect /);
    // 11 年 → 11 个柱子（rect）
    expect(svg.match(/<rect /g) || []).toHaveLength(11);
    // 含 271（2014 起始）+ 251（2024 末尾）真实值
    expect(svg).toContain(">271<");
    expect(svg).toContain(">251<");
    writeFileSync(join(SNAPSHOT_DIR, "lancet-volume-bar.svg"), svg, "utf-8");
  });

  it("renders single-year input (length=1 boundary, 1 bar OK)", () => {
    const svg = renderAnnualVolumeBarChart([{ year: 2024, count: 100 }]);
    expect(svg).toContain("<rect ");
    expect(svg).toContain(">100<");
    expect(svg.match(/<rect /g) || []).toHaveLength(1);
  });

  it("returns empty string for empty array", () => {
    expect(renderAnnualVolumeBarChart([])).toBe("");
  });

  it("filters out zero/negative counts; returns '' if 0 valid remain", () => {
    expect(
      renderAnnualVolumeBarChart([
        { year: 2023, count: 0 },
        { year: 2024, count: -5 },
      ]),
    ).toBe("");
  });
});
