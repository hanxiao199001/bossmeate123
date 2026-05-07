/**
 * PR Q.5 D4：chart_config 解析器（template.chart_config jsonb → 渲染层使用的 typesSet + colors）。
 *
 * D4 范围：4 套模板用现有 4 chart 函数（if-history-line / car-history-line /
 * annual-volume-bar / citing-pie）的子集 + colors 主题色注入。新 chart 类型
 * （accept-rate-bar / fee-pie / review-cycle-bar / subject-distribution）在 D5 单独 PR 加。
 * 当前 chart_config.types 含 D5 新名时静默跳过。
 */
import { logger } from "../../config/logger.js";

export const KNOWN_CHART_TYPES = new Set([
  "if-history-line",
  "car-history-line",
  "annual-volume-bar",
  "citing-pie",
]);

export interface ChartColorPalette {
  primary: string;     // 主色（折线 / 饼图主块 / 柱状）
  accent: string;      // 辅色（次要数据点 / 阴影）
  warn: string;        // 警告色（CAR high risk / 异常值）
  bg: string;          // 浅底色
}

/** 4 套 colors 主题（与 css_theme.palette 对齐）。chart SVG 直接吃 fill/stroke。 */
const PALETTES: Record<string, ChartColorPalette> = {
  "blue-gray":       { primary: "#2C5F8D", accent: "#5A7FA8", warn: "#E63946", bg: "#F5F7FA" }, // A 学术
  "orange-red":      { primary: "#FF6B35", accent: "#F7B538", warn: "#E63946", bg: "#FFF8F0" }, // B 营销
  "cyan-mint":       { primary: "#00B4D8", accent: "#FFC857", warn: "#E76F51", bg: "#F0FBFF" }, // C 科普
  "purple-indigo":   { primary: "#6B46C1", accent: "#9F7AEA", warn: "#DD6B20", bg: "#F8F5FF" }, // E 行业
};

export interface ResolvedChartConfig {
  /** 该模板要渲染的 chart 类型集合（小写 kebab-case，与 KNOWN_CHART_TYPES 交集）*/
  typesSet: Set<string>;
  palette: ChartColorPalette;
  colorsName: string;
}

/** chart_config jsonb → ResolvedChartConfig。template 缺 chart_config 时走默认（A 学术 4 chart）。*/
export function resolveChartConfig(chartConfig: unknown): ResolvedChartConfig {
  const cfg = (chartConfig ?? {}) as { types?: string[]; colors?: string };
  const requestedTypes = Array.isArray(cfg.types) ? cfg.types : [];
  const validTypes = new Set<string>();
  for (const t of requestedTypes) {
    if (KNOWN_CHART_TYPES.has(t)) validTypes.add(t);
    else logger.debug({ unknownChartType: t }, "Q.5: chart_config.types 含未知类型，跳过（D5 添加）");
  }
  // 兜底：types 全无效 → 全 4 chart 都渲染（向后兼容）
  if (validTypes.size === 0) {
    KNOWN_CHART_TYPES.forEach((t) => validTypes.add(t));
  }
  const colorsName = typeof cfg.colors === "string" ? cfg.colors : "blue-gray";
  const palette = PALETTES[colorsName] ?? PALETTES["blue-gray"];
  return { typesSet: validTypes, palette, colorsName };
}
