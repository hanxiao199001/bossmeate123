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
  primary: string;        // 主色（章节标题 / 链接 / 主图表）
  accent: string;         // 强调色（数据高亮 / 红色警告 — 4 套差异化）
  warn: string;           // 警告语义色（CAR high risk / 异常值）
  bg: string;             // chart SVG 背景
  // PR Q.7.2：shunshi-style 模板 palette 化补充字段
  primaryBg: string;      // 主色浅底（信息卡片背景，原 #E3F2FD）
  cardBg: string;         // 卡片浅灰底（原 #FAFAFA）
  borderColor: string;    // 边框 / 标签底（原 #F5F5F5）
}

/** 4 套 colors 主题（与 css_theme.palette 对齐）。 */
const PALETTES: Record<string, ChartColorPalette> = {
  "blue-gray":     { primary: "#2C5F8D", accent: "#1976D2", warn: "#E63946", bg: "#F5F7FA",
                     primaryBg: "#E3F2FD", cardBg: "#F5F7FA", borderColor: "#D1D9E0" }, // A 学术
  "orange-red":    { primary: "#DC143C", accent: "#FF6B35", warn: "#E63946", bg: "#FFF8F0",
                     primaryBg: "#FFF0F0", cardBg: "#FFF8F0", borderColor: "#FFD9C9" }, // B 营销
  "cyan-mint":     { primary: "#F39C12", accent: "#00B4D8", warn: "#E76F51", bg: "#FFF8DC",
                     primaryBg: "#FFF8DC", cardBg: "#FFF8E1", borderColor: "#FFE0A8" }, // C 科普
  "purple-indigo": { primary: "#6B46C1", accent: "#8B5CF6", warn: "#DD6B20", bg: "#F8F5FF",
                     primaryBg: "#F5F3FF", cardBg: "#F8F5FF", borderColor: "#DDD6FE" }, // E 行业
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
