/**
 * CAR 历史折线图（C.2 阶段，shunshi-style 区块 6）
 *
 * 输入：[{year, carIndex}, ...]，5 年区间最佳；carIndex 是 0-1 区间小数。
 * riskLevel 决定 viewBox 背景半透明带（low 浅绿 / mid 浅黄 / high 浅红）。
 *
 * 渲染策略：
 *  - 折线 + 圆点 marker（同 IF 折线 pattern）
 *  - x 轴年份（5 年全标）
 *  - y 轴标百分比（0%, max%）
 *  - 数据 < 2 点 → 返回空字符串（调用方 P1 占位）
 */

import { escSvg, scaleY } from "./svg-utils.js";

const W = 600;
const H = 260;
const PAD_L = 50;
const PAD_R = 30;
const PAD_T = 30;
const PAD_B = 40;
// PR Q.6 D5：palette 占位，4 套主色注入
const STROKE = "{{PRIMARY}}";
const POINT = "{{PRIMARY}}";
const GRID = "#E0E0E0";
const TEXT_COLOR = "#333";
const MUTED = "#999";

const RISK_BAND: Record<"low" | "mid" | "high", { fill: string; label: string; labelColor: string }> = {
  low: { fill: "#C8E6C9", label: "低风险", labelColor: "#388E3C" },
  mid: { fill: "#FFE082", label: "中等风险", labelColor: "#F57C00" },
  high: { fill: "#FFCDD2", label: "高风险", labelColor: "#D32F2F" },
};

export function renderCarHistoryLineChart(
  data: ReadonlyArray<{ year: number; carIndex: number }>,
  riskLevel: "low" | "mid" | "high",
  // PR #214: jcarindex 的 carIndex 原值即百分数(0.87→"0.87%"); percentMode=true 时标签不再×100.
  percentMode = false,
): string {
  if (!Array.isArray(data) || data.length < 2) return "";
  const points = [...data]
    .filter((d) => isFinite(d.carIndex) && d.carIndex >= 0)
    .sort((a, b) => a.year - b.year);
  if (points.length < 2) return "";

  const values = points.map((p) => p.carIndex);
  const vMin = 0;
  const vMax = Math.max(...values, 0.01) * 1.2;
  const yBottom = H - PAD_B;
  const yTop = PAD_T;
  const xLeft = PAD_L;
  const xRight = W - PAD_R;
  const step = (xRight - xLeft) / (points.length - 1);

  const band = RISK_BAND[riskLevel];

  const xy = points.map((p, i) => ({
    x: xLeft + step * i,
    y: scaleY(p.carIndex, vMin, vMax, yBottom, yTop),
    year: p.year,
    v: p.carIndex,
  }));

  const polyline = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const dots = xy
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${POINT}"/>`)
    .join("");
  const valueLabels = xy
    .map(
      (p) =>
        `<text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" font-weight="bold">${(percentMode ? p.v : p.v * 100).toFixed(2)}%</text>`,
    )
    .join("");
  const xLabels = xy
    .map(
      (p) =>
        `<text x="${p.x.toFixed(1)}" y="${(yBottom + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${MUTED}">${p.year}</text>`,
    )
    .join("");
  const grid = [0, 0.33, 0.66, 1]
    .map((t) => {
      const y = yBottom - t * (yBottom - yTop);
      return `<line x1="${xLeft}" y1="${y.toFixed(1)}" x2="${xRight}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    })
    .join("");
  const yAxisLabels =
    `<text x="${xLeft - 6}" y="${yTop + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${(percentMode ? vMax : vMax * 100).toFixed(2)}%</text>` +
    `<text x="${xLeft - 6}" y="${yBottom + 4}" text-anchor="end" font-size="10" fill="${MUTED}">0%</text>`;

  // 风险带：整个绘图区背景半透明色 + 右上角 riskLevel 文字标签
  const riskBand =
    `<rect x="${xLeft}" y="${yTop}" width="${xRight - xLeft}" height="${yBottom - yTop}" fill="${band.fill}" fill-opacity="0.35"/>` +
    `<text x="${xRight - 6}" y="${yTop + 14}" text-anchor="end" font-size="12" fill="${band.labelColor}" font-weight="bold">${escSvg(band.label)}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:600px;display:block;margin:0 auto;">` +
    riskBand +
    grid +
    yAxisLabels +
    `<polyline fill="none" stroke="${STROKE}" stroke-width="2" points="${polyline}"/>` +
    dots +
    valueLabels +
    xLabels +
    `</svg>`
  );
}
