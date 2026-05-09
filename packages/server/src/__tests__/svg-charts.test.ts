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
  renderCarHistoryLineChart,
  renderCitingPieChart,
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

// ===== Lancet 真实 CAR + citing 数据（PR #35 R4 enrich-all DB ground truth）=====
const LANCET_CAR_HISTORY: ReadonlyArray<{ year: number; carIndex: number }> = [
  { year: 2021, carIndex: 0.0317 },
  { year: 2022, carIndex: 0.0476 },
  { year: 2023, carIndex: 0.0549 },
  { year: 2024, carIndex: 0.0612 },
  { year: 2025, carIndex: 0.0695 },
];

const LANCET_CITING_TOP10: ReadonlyArray<{ name: string; count: number; percent: number }> = [
  { name: "Research Square", count: 1900, percent: 19 },
  { name: "BMJ", count: 1500, percent: 15 },
  { name: "Cochrane Database of Systematic Reviews", count: 1200, percent: 12 },
  { name: "JAMA", count: 1000, percent: 10 },
  { name: "PLOS ONE", count: 900, percent: 9 },
  { name: "Nature", count: 800, percent: 8 },
  { name: "NEJM", count: 700, percent: 7 },
  { name: "Lancet Oncology", count: 600, percent: 6 },
  { name: "Lancet Public Health", count: 500, percent: 5 },
  { name: "BMC Public Health", count: 400, percent: 4 },
];

describe("renderCarHistoryLineChart", () => {
  it("renders 5-year Lancet CAR with viewBox + risk band + 5 markers", () => {
    const svg = renderCarHistoryLineChart(LANCET_CAR_HISTORY, "mid");
    expect(svg.length).toBeGreaterThan(500);
    expect(svg).toMatch(/viewBox="0 0 600 260"/);
    expect(svg).toMatch(/<polyline /);
    expect(svg.match(/<circle /g) || []).toHaveLength(5);
    // 风险带：mid → #FFE082 浅黄
    expect(svg).toContain("#FFE082");
    expect(svg).toContain("中等风险");
    // 实际值百分比标签：6.95% (2025 latest)
    expect(svg).toContain("6.95%");
    expect(svg).toContain("3.17%"); // 2021 起始
    // x 轴年份
    expect(svg).toContain(">2021<");
    expect(svg).toContain(">2025<");
    writeFileSync(join(SNAPSHOT_DIR, "lancet-car-line.svg"), svg, "utf-8");
  });

  it("colors high risk band red (#FFCDD2) with 高风险 label", () => {
    const svg = renderCarHistoryLineChart(LANCET_CAR_HISTORY, "high");
    expect(svg).toContain("#FFCDD2");
    expect(svg).toContain("高风险");
  });

  it("colors low risk band green (#C8E6C9) with 低风险 label", () => {
    const svg = renderCarHistoryLineChart(LANCET_CAR_HISTORY, "low");
    expect(svg).toContain("#C8E6C9");
    expect(svg).toContain("低风险");
  });

  it("returns empty string for single-point input (caller falls back to placeholder)", () => {
    expect(renderCarHistoryLineChart([{ year: 2025, carIndex: 0.05 }], "mid")).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(renderCarHistoryLineChart([], "low")).toBe("");
  });
});

describe("renderCitingPieChart", () => {
  it("renders top-10 Lancet citing with 6 slices (top 5 + 其他) + legend", () => {
    const svg = renderCitingPieChart(LANCET_CITING_TOP10);
    expect(svg.length).toBeGreaterThan(500);
    expect(svg).toMatch(/viewBox="0 0 600 320"/);
    // 6 path 扇区（top 5 + 其他）
    expect(svg.match(/<path /g) || []).toHaveLength(6);
    // legend 用 6 色（top 5 + 其他）
    // PR #113（5-10）: top 1 改 palette 占位 {{PRIMARY}}（PR Q.6 D5），run-time replaceAll 套主色
    expect(svg).toContain("{{PRIMARY}}"); // top 1 占位（4 套主色注入）
    expect(svg).toContain("#9E9E9E"); // 其他 灰
    // legend label：Research Square + 其他
    expect(svg).toContain("Research Square");
    expect(svg).toContain("其他");
    writeFileSync(join(SNAPSHOT_DIR, "lancet-citing-pie.svg"), svg, "utf-8");
  });

  it("renders top-3 only (no 其他 slice)", () => {
    const svg = renderCitingPieChart(LANCET_CITING_TOP10.slice(0, 3));
    expect(svg).toMatch(/<path /);
    expect(svg.match(/<path /g) || []).toHaveLength(3);
    expect(svg).not.toContain("其他");
  });

  it("does NOT render 自引 slice when confidence='low' (this PR's default)", () => {
    const svg = renderCitingPieChart(LANCET_CITING_TOP10, 0.0034, "low");
    expect(svg).not.toContain("自引");
    // 仍是 6 扇区（top 5 + 其他）
    expect(svg.match(/<path /g) || []).toHaveLength(6);
  });

  it("renders 自引 slice when confidence='medium' (task #50 follow-up)", () => {
    const svg = renderCitingPieChart(LANCET_CITING_TOP10, 0.0034, "medium");
    expect(svg).toContain("自引");
    expect(svg).toContain("#5D4037"); // 自引 棕
    // 7 扇区（top 5 + 其他 + 自引）
    expect(svg.match(/<path /g) || []).toHaveLength(7);
  });

  it("returns empty string for empty input", () => {
    expect(renderCitingPieChart([])).toBe("");
  });

  it("filters out zero/negative weights; returns '' if all zero", () => {
    expect(
      renderCitingPieChart([
        { name: "A", count: 0 },
        { name: "B", percent: 0 },
      ]),
    ).toBe("");
  });
});
