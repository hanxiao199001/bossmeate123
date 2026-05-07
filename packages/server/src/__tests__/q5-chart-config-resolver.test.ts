/**
 * PR Q.5 D4：chart_config 解析 + 数字幻觉 hotfix 防回归（纯逻辑复刻 PR B.12 范式）。
 */
import { describe, it, expect } from "vitest";

// 复刻 chart-config-resolver.ts 的纯逻辑（避开 logger.ts → env.ts 加载链）
const KNOWN_CHART_TYPES = new Set(["if-history-line", "car-history-line", "annual-volume-bar", "citing-pie"]);
const PALETTES: Record<string, { primary: string }> = {
  "blue-gray": { primary: "#2C5F8D" },
  "orange-red": { primary: "#FF6B35" },
  "cyan-mint": { primary: "#00B4D8" },
  "purple-indigo": { primary: "#6B46C1" },
};
function resolveChartConfig(cfg: any) {
  const requestedTypes = Array.isArray(cfg?.types) ? cfg.types : [];
  const validTypes = new Set<string>();
  for (const t of requestedTypes) if (KNOWN_CHART_TYPES.has(t)) validTypes.add(t);
  if (validTypes.size === 0) KNOWN_CHART_TYPES.forEach((t) => validTypes.add(t));
  const colorsName = typeof cfg?.colors === "string" ? cfg.colors : "blue-gray";
  return { typesSet: validTypes, palette: PALETTES[colorsName] ?? PALETTES["blue-gray"], colorsName };
}

describe("PR Q.5: resolveChartConfig 4 套 typesSet", () => {
  it("A 4 chart 全 hit + blue-gray", () => {
    const r = resolveChartConfig({
      types: ["if-history-line", "car-history-line", "annual-volume-bar", "citing-pie"],
      colors: "blue-gray",
    });
    expect(r.typesSet.size).toBe(4);
    expect(r.palette.primary).toBe("#2C5F8D");
  });
  it("B 3 chart 子集 + orange-red", () => {
    const r = resolveChartConfig({
      types: ["if-history-line", "annual-volume-bar", "citing-pie"],
      colors: "orange-red",
    });
    expect(r.typesSet.size).toBe(3);
    expect(r.typesSet.has("car-history-line")).toBe(false);
    expect(r.palette.primary).toBe("#FF6B35");
  });
  it("D5 新 chart 类型静默跳过", () => {
    const r = resolveChartConfig({
      types: ["if-history-line", "accept-rate-bar", "fee-pie", "subject-distribution"],
      colors: "purple-indigo",
    });
    expect(r.typesSet.size).toBe(1);
    expect(r.typesSet.has("if-history-line")).toBe(true);
  });
  it("types 全无效 → 兜底全 4（向后兼容）", () => {
    expect(resolveChartConfig({ types: ["foo", "bar"], colors: "blue-gray" }).typesSet.size).toBe(4);
  });
  it("空 chart_config → 默认 blue-gray + 全 4 chart", () => {
    const r = resolveChartConfig(null);
    expect(r.typesSet.size).toBe(4);
    expect(r.colorsName).toBe("blue-gray");
  });
  it("4 套 palette 主色互不重复", () => {
    const palettes = ["blue-gray", "orange-red", "cyan-mint", "purple-indigo"]
      .map((c) => resolveChartConfig({ types: [], colors: c }).palette.primary);
    expect(new Set(palettes).size).toBe(4);
  });
});

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.5: 防回归 grep", () => {
  it("template-prompt-injector 含数字真实性硬约束（task #54）", async () => {
    const src = await readSrc("../services/skills/template-prompt-injector.ts");
    expect(src).toMatch(/数字真实性硬约束/);
    expect(src).toMatch(/metadata\.impactFactor/);
    expect(src).toMatch(/禁止引用 ifHistory 数组中的历史峰值/);
    expect(src).toMatch(/NUMBER_CONSTRAINT_SUFFIX/);
  });

  it("shunshi-style 4 chart 前 typesSet.has 判断", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/typesSet\.has\("if-history-line"\)/);
    expect(src).toMatch(/typesSet\.has\("car-history-line"\)/);
    expect(src).toMatch(/typesSet\.has\("annual-volume-bar"\)/);
    expect(src).toMatch(/typesSet\.has\("citing-pie"\)/);
    expect(src).toMatch(/resolveChartConfig\(chartConfig\)/);
  });

  it("article-skill 透传 chartConfig 给 htmlGenerator", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/templateAware\.chartConfig/);
  });

  it("migrate.ts 含 B/E chart_config UPDATE 修订（idempotent）", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/chart_config.types 修订到现有 4 chart 子集/);
    expect(src).toMatch(/WHERE name='marketing-conversion'/);
    expect(src).toMatch(/WHERE name='industry-vertical'/);
  });
});
