/**
 * PR Q.6 D5：4 新 chart + chart palette 注入 + structure_json + emoji 强约束 防回归。
 */
import { describe, it, expect } from "vitest";
import { renderAcceptRateBarChart } from "../services/publisher/svg-charts/accept-rate-bar-chart.js";
import { renderFeePieChart } from "../services/publisher/svg-charts/fee-pie-chart.js";
import { renderSubjectDistributionChart } from "../services/publisher/svg-charts/subject-distribution-chart.js";
import { renderReviewCycleBarChart } from "../services/publisher/svg-charts/review-cycle-bar-chart.js";

describe("PR Q.6 D5: 4 新 chart 函数", () => {
  it("accept-rate-bar 接受 0-1 / 0-100 范围 + 含 {{PRIMARY}} 占位", () => {
    const svg1 = renderAcceptRateBarChart(0.04);
    expect(svg1).toContain("{{PRIMARY}}");
    expect(svg1).toContain("4.0%");
    expect(svg1).toContain("极难录用");
    const svg2 = renderAcceptRateBarChart(35);
    expect(svg2).toContain("35.0%");
    expect(svg2).toContain("录用率友好");
    expect(renderAcceptRateBarChart(null)).toBe("");
  });

  it("fee-pie 含 2 区饼图 + 性价比判断", () => {
    const cheap = renderFeePieChart(1200);
    expect(cheap).toContain("{{PRIMARY}}");
    expect(cheap).toContain("性价比优");
    expect(renderFeePieChart(3500)).toContain("费用较高");
    expect(renderFeePieChart(null)).toBe("");
  });

  it("subject-distribution 多区饼图 + 第一区 {{PRIMARY}}", () => {
    const svg = renderSubjectDistributionChart([
      { subject: "MEDICINE", percent: 50 },
      { subject: "BIOLOGY", percent: 30 },
      { subject: "PUBLIC HEALTH", percent: 20 },
    ]);
    expect(svg).toContain("{{PRIMARY}}");
    expect(svg).toContain("MEDICINE");
    expect(svg).toContain("50.0%");
    expect(renderSubjectDistributionChart([])).toBe("");
  });

  it("review-cycle-bar 解析周数范围", () => {
    const fast = renderReviewCycleBarChart("2-4 周");
    expect(fast).toContain("极速审稿");
    expect(fast).toContain("{{PRIMARY}}");
    const slow = renderReviewCycleBarChart("16-20 周");
    expect(slow).toContain("审稿较慢");
    expect(renderReviewCycleBarChart(null)).toBe("");
  });
});

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.6 D5: chart palette + shunshi:834 占位 + sectionCount 接入", () => {
  it("4 现有 chart 顶部主色 const 改占位（PRIMARY/ACCENT）", async () => {
    expect(await readSrc("../services/publisher/svg-charts/if-history-line-chart.ts")).toMatch(/const STROKE = "\{\{ACCENT\}\}"/);
    expect(await readSrc("../services/publisher/svg-charts/car-history-line-chart.ts")).toMatch(/const STROKE = "\{\{PRIMARY\}\}"/);
    expect(await readSrc("../services/publisher/svg-charts/annual-volume-bar-chart.ts")).toMatch(/const BAR_FILL = "\{\{PRIMARY\}\}"/);
    expect(await readSrc("../services/publisher/svg-charts/citing-pie-chart.ts")).toMatch(/"\{\{PRIMARY\}\}".*"#388E3C"/);
  });

  it("shunshi:834 marketingCta linear-gradient 改占位", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/linear-gradient\(135deg,\{\{PRIMARY\}\},\{\{ACCENT\}\}\)/);
  });

  it("generateShunshiStyleHtml 加 sectionCount 第 6 参数 + sections.slice", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/sectionCount\?:\s*number/);
    expect(src).toMatch(/sectionCount && sectionCount < visible\.length/);
    expect(src).toMatch(/visible\.slice\(0, sectionCount\)/);
  });

  it("emoji_use 强约束 wording（mandatory 措辞）", async () => {
    const src = await readSrc("../services/skills/template-prompt-injector.ts");
    expect(src).toMatch(/严禁/);
    expect(src).toMatch(/格式错误/);
    expect(src).toMatch(/必须.*≥8/);
    expect(src).toMatch(/PR Q\.6 D5/);
  });

  it("KNOWN_CHART_TYPES 加 4 新类型", async () => {
    const src = await readSrc("../services/skills/chart-config-resolver.ts");
    expect(src).toMatch(/"accept-rate-bar"/);
    expect(src).toMatch(/"fee-pie"/);
    expect(src).toMatch(/"subject-distribution"/);
    expect(src).toMatch(/"review-cycle-bar"/);
  });

  it("migrate.ts B/E chart_config UPDATE 含 4 新 chart 类型", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/accept-rate-bar.*fee-pie/);
    expect(src).toMatch(/subject-distribution/);
  });
});
