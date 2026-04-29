/**
 * IF 历史折线图（C 阶段，shunshi-style 区块 4）
 *
 * 输入：[{ year: 2015, if: 44.002 }, ..., { year: 2024, if: 88.5 }]
 * 输出：inline SVG 字符串（viewBox 600×260），微信公众号兼容
 *
 * 渲染策略：
 *  - polyline 描点 + 每个点小圆 marker
 *  - x 轴年份（≥6 年时只标首尾 + 中间 1 个）
 *  - y 轴数值标签（每点上方）+ 网格线 4 条
 *  - 数据 ≤ 1 点时返回空字符串（调用方走 P1 占位）
 */

import { escSvg, fmtValue, scaleY } from "./svg-utils.js";

const W = 600;
const H = 260;
const PAD_L = 50;
const PAD_R = 30;
const PAD_T = 30;
const PAD_B = 40;
const STROKE = "#DC143C"; // 期刊推荐红
const POINT = "#DC143C";
const GRID = "#E0E0E0";
const TEXT_COLOR = "#333";
const MUTED = "#999";

export function renderIfHistoryLineChart(
  data: ReadonlyArray<{ year: number; if: number }>,
): string {
  if (!Array.isArray(data) || data.length < 2) return "";
  // 排序 + 去掉非有限值
  const points = [...data]
    .filter((d) => isFinite(d.if) && d.if > 0)
    .sort((a, b) => a.year - b.year);
  if (points.length < 2) return "";

  const values = points.map((p) => p.if);
  const vMin = Math.min(...values) * 0.92;
  const vMax = Math.max(...values) * 1.08;
  const yBottom = H - PAD_B;
  const yTop = PAD_T;
  const xLeft = PAD_L;
  const xRight = W - PAD_R;
  const step = (xRight - xLeft) / (points.length - 1);

  const xy = points.map((p, i) => ({
    x: xLeft + step * i,
    y: scaleY(p.if, vMin, vMax, yBottom, yTop),
    year: p.year,
    v: p.if,
  }));

  const polyline = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const dots = xy
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${POINT}"/>`)
    .join("");
  const valueLabels = xy
    .map(
      (p) =>
        `<text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="${TEXT_COLOR}" font-weight="bold">${escSvg(fmtValue(p.v))}</text>`,
    )
    .join("");
  // x 轴标签：≥6 年只标首/中/尾，否则全标
  const labelIdx =
    xy.length <= 5 ? xy.map((_, i) => i) : [0, Math.floor((xy.length - 1) / 2), xy.length - 1];
  const xLabels = labelIdx
    .map(
      (i) =>
        `<text x="${xy[i].x.toFixed(1)}" y="${(yBottom + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${MUTED}">${xy[i].year}</text>`,
    )
    .join("");
  // 4 条水平网格（含 top / bottom）
  const grid = [0, 0.33, 0.66, 1]
    .map((t) => {
      const y = yBottom - t * (yBottom - yTop);
      return `<line x1="${xLeft}" y1="${y.toFixed(1)}" x2="${xRight}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    })
    .join("");
  // y 轴 min/max 标签
  const yAxisLabels =
    `<text x="${xLeft - 6}" y="${yTop + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${escSvg(fmtValue(vMax))}</text>` +
    `<text x="${xLeft - 6}" y="${yBottom + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${escSvg(fmtValue(vMin))}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:600px;display:block;margin:0 auto;">` +
    grid +
    yAxisLabels +
    `<polyline fill="none" stroke="${STROKE}" stroke-width="2" points="${polyline}"/>` +
    dots +
    valueLabels +
    xLabels +
    `</svg>`
  );
}
