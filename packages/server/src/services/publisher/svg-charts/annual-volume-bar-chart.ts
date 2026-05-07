/**
 * 年发文量柱状图（C 阶段，shunshi-style 区块 11）
 *
 * 输入：[{ year: 2014, count: 271 }, ..., { year: 2024, count: 251 }]
 * 输出：inline SVG 字符串（viewBox 600×260），微信公众号兼容
 *
 * 渲染策略：
 *  - 每年一个 rect 柱（高度按 count 比例）
 *  - x 轴年份（≥6 年时只标首尾 + 中间 1 个，与 IF 折线图保持一致）
 *  - 柱顶值标签
 *  - 数据 ≤ 0 点时返回空字符串（调用方走 P1 占位）
 */

import { escSvg, scaleY } from "./svg-utils.js";

const W = 600;
const H = 260;
const PAD_L = 50;
const PAD_R = 30;
const PAD_T = 30;
const PAD_B = 40;
// PR Q.6 D5：palette 占位，4 套主色注入
const BAR_FILL = "{{PRIMARY}}";
const GRID = "#E0E0E0";
const TEXT_COLOR = "#333";
const MUTED = "#999";

export function renderAnnualVolumeBarChart(
  data: ReadonlyArray<{ year: number; count: number }>,
): string {
  if (!Array.isArray(data) || data.length < 1) return "";
  const points = [...data]
    .filter((d) => isFinite(d.count) && d.count > 0)
    .sort((a, b) => a.year - b.year);
  if (points.length < 1) return "";

  const values = points.map((p) => p.count);
  const vMin = 0;
  const vMax = Math.max(...values) * 1.15;
  const yBottom = H - PAD_B;
  const yTop = PAD_T;
  const xLeft = PAD_L;
  const xRight = W - PAD_R;
  const slot = (xRight - xLeft) / points.length;
  const barW = Math.max(8, slot * 0.65);

  const bars = points
    .map((p, i) => {
      const cx = xLeft + slot * i + slot / 2;
      const yTopBar = scaleY(p.count, vMin, vMax, yBottom, yTop);
      const barH = yBottom - yTopBar;
      const x = cx - barW / 2;
      return (
        `<rect x="${x.toFixed(1)}" y="${yTopBar.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${BAR_FILL}"/>` +
        `<text x="${cx.toFixed(1)}" y="${(yTopBar - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" font-weight="bold">${escSvg(p.count)}</text>`
      );
    })
    .join("");

  const labelIdx =
    points.length <= 5 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xLabels = labelIdx
    .map((i) => {
      const cx = xLeft + slot * i + slot / 2;
      return `<text x="${cx.toFixed(1)}" y="${(yBottom + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${MUTED}">${points[i].year}</text>`;
    })
    .join("");
  const grid = [0, 0.33, 0.66, 1]
    .map((t) => {
      const y = yBottom - t * (yBottom - yTop);
      return `<line x1="${xLeft}" y1="${y.toFixed(1)}" x2="${xRight}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    })
    .join("");
  const yAxisLabels =
    `<text x="${xLeft - 6}" y="${yTop + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${escSvg(Math.round(vMax))}</text>` +
    `<text x="${xLeft - 6}" y="${yBottom + 4}" text-anchor="end" font-size="10" fill="${MUTED}">0</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:600px;display:block;margin:0 auto;">` +
    grid +
    yAxisLabels +
    bars +
    xLabels +
    `</svg>`
  );
}
