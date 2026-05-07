/**
 * 引用前 10 期刊饼图（C.2 阶段，shunshi-style 区块 13）
 *
 * 输入：topJournals top 10、selfCitationRate (0-1)、confidence (low/medium/high)。
 * 渲染：
 *  - top 5 期刊各占独立扇区
 *  - "其他" 扇区（合并 top 6-10 的 weight）
 *  - "自引" 扇区（仅 confidence ≥ medium 时渲染；本 PR confidence='low' → 不渲染）
 *  - 右侧 legend 列出 name + 百分比
 *
 * 兼容性：raw SVG arc path（M / L / A / Z），不依赖 D3。
 * 数据 < 1 项或 weight 全 0 → 返回空字符串（调用方走 P1 占位）。
 */

import { escSvg } from "./svg-utils.js";

const W = 600;
const H = 320;
const CX = 150;
const CY = 160;
const R = 120;

// PR Q.6 D5：top 1 用 palette.primary 占位（4 套真主色），其他保留语义色（绿推荐 / 橙注意 / 紫 / 红警告 / 灰）
const PALETTE = ["{{PRIMARY}}", "#388E3C", "#F57C00", "#7B1FA2", "#D32F2F", "#9E9E9E", "#5D4037"] as const;

const LEGEND_X = 290;
const LEGEND_Y = 50;
const LEGEND_ROW_H = 26;
const LEGEND_BOX = 14;

interface TopJournalIn {
  name: string;
  count?: number;
  percent?: number;
}

interface Slice {
  label: string;
  value: number;
  color: string;
}

export function renderCitingPieChart(
  topJournals: ReadonlyArray<TopJournalIn>,
  selfCitationRate?: number,
  selfCitationConfidence?: "low" | "medium" | "high",
): string {
  if (!Array.isArray(topJournals) || topJournals.length === 0) return "";

  // weight 优先用 percent；否则 count 兜底
  const weighted = topJournals
    .filter((j) => j && typeof j.name === "string" && j.name.trim())
    .map((j) => {
      const w =
        typeof j.percent === "number" && Number.isFinite(j.percent)
          ? j.percent
          : typeof j.count === "number" && Number.isFinite(j.count)
            ? j.count
            : 0;
      return { name: j.name.trim(), weight: w };
    })
    .filter((j) => j.weight > 0);
  if (weighted.length === 0) return "";

  const slices: Slice[] = [];
  weighted.slice(0, 5).forEach((j, i) => {
    slices.push({ label: j.name, value: j.weight, color: PALETTE[i] });
  });
  if (weighted.length > 5) {
    const others = weighted.slice(5).reduce((acc, j) => acc + j.weight, 0);
    if (others > 0) slices.push({ label: "其他", value: others, color: PALETTE[5] });
  }

  // 自引：仅 confidence ≥ medium 才渲染（task #50 升级 medium 后自动展示）
  const showSelf =
    typeof selfCitationRate === "number" &&
    Number.isFinite(selfCitationRate) &&
    selfCitationRate > 0 &&
    (selfCitationConfidence === "medium" || selfCitationConfidence === "high");
  if (showSelf) {
    // 自引 weight = selfCitationRate × top-N weight 总和（与 topJournals percent 同量纲）
    const topSum = slices.reduce((acc, s) => acc + s.value, 0);
    const selfWeight = (selfCitationRate as number) * topSum;
    if (selfWeight > 0) slices.push({ label: "自引", value: selfWeight, color: PALETTE[6] });
  }

  const total = slices.reduce((acc, s) => acc + s.value, 0);
  if (total <= 0) return "";

  let cumAngle = -Math.PI / 2; // 12 点钟方向起算
  const paths: string[] = [];
  const legendRows: string[] = [];

  slices.forEach((s, i) => {
    const ratio = s.value / total;
    const startAngle = cumAngle;
    const endAngle = cumAngle + ratio * Math.PI * 2;
    cumAngle = endAngle;

    let d: string;
    if (slices.length === 1) {
      // 单扇区 = 整圆（双 180° arc 拼接）
      d =
        `M ${(CX - R).toFixed(2)},${CY.toFixed(2)} ` +
        `A ${R},${R} 0 1,1 ${(CX + R).toFixed(2)},${CY.toFixed(2)} ` +
        `A ${R},${R} 0 1,1 ${(CX - R).toFixed(2)},${CY.toFixed(2)} Z`;
    } else {
      const x1 = CX + R * Math.cos(startAngle);
      const y1 = CY + R * Math.sin(startAngle);
      const x2 = CX + R * Math.cos(endAngle);
      const y2 = CY + R * Math.sin(endAngle);
      const largeArc = ratio > 0.5 ? 1 : 0;
      d =
        `M ${CX.toFixed(2)},${CY.toFixed(2)} ` +
        `L ${x1.toFixed(2)},${y1.toFixed(2)} ` +
        `A ${R},${R} 0 ${largeArc},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
    }
    paths.push(`<path d="${d}" fill="${s.color}" stroke="#FFFFFF" stroke-width="1.5"/>`);

    // legend 行：色块 + 名称（截断 28 字） + 百分比
    const ly = LEGEND_Y + i * LEGEND_ROW_H;
    const pct = (ratio * 100).toFixed(1);
    const labelTrunc = s.label.length > 28 ? `${s.label.slice(0, 26)}…` : s.label;
    legendRows.push(
      `<rect x="${LEGEND_X}" y="${ly}" width="${LEGEND_BOX}" height="${LEGEND_BOX}" fill="${s.color}"/>` +
        `<text x="${LEGEND_X + LEGEND_BOX + 8}" y="${ly + LEGEND_BOX - 2}" font-size="13" fill="#333">${escSvg(labelTrunc)} <tspan fill="#666" font-weight="600">${pct}%</tspan></text>`,
    );
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:600px;display:block;margin:0 auto;">` +
    paths.join("") +
    legendRows.join("") +
    `</svg>`
  );
}
