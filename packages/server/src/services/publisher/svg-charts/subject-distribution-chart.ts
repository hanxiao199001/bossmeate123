/**
 * 学科分布饼图（PR Q.6 D5，E 行业垂直专属第 5 chart）
 *
 * 输入：[{ subject: "MEDICINE", percent: 38.5 }, ...]
 * 输出：inline SVG 600×280，6 区饼图 + 图例
 * palette 占位 {{PRIMARY}} 第一区，其他保留语义色
 */
import { escSvg } from "./svg-utils.js";

const W = 600, H = 280, CX = 180, CY = 140, R = 100;
const COLORS = ["{{PRIMARY}}", "#388E3C", "#F57C00", "#7B1FA2", "#D32F2F", "#9E9E9E"];

export function renderSubjectDistributionChart(
  data: ReadonlyArray<{ subject: string; percent: number }>,
): string {
  if (!Array.isArray(data) || data.length === 0) return "";
  const valid = data.filter((d) => isFinite(d.percent) && d.percent > 0).slice(0, 6);
  if (valid.length === 0) return "";
  const total = valid.reduce((s, d) => s + d.percent, 0);
  if (total <= 0) return "";

  const paths: string[] = [];
  const legends: string[] = [];
  let acc = 0;
  valid.forEach((d, i) => {
    const startA = (acc / total) * Math.PI * 2;
    acc += d.percent;
    const endA = (acc / total) * Math.PI * 2;
    const x1 = CX + R * Math.sin(startA), y1 = CY - R * Math.cos(startA);
    const x2 = CX + R * Math.sin(endA), y2 = CY - R * Math.cos(endA);
    const largeArc = endA - startA > Math.PI ? 1 : 0;
    paths.push(
      `<path d="M ${CX} ${CY} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${COLORS[i] ?? "#999"}" stroke="#fff" stroke-width="2"/>`,
    );
    const ly = 80 + i * 26;
    const subj = d.subject.length > 14 ? d.subject.slice(0, 13) + "…" : d.subject;
    legends.push(
      `<rect x="340" y="${ly}" width="14" height="14" fill="${COLORS[i] ?? "#999"}"/>` +
      `<text x="362" y="${ly + 12}" font-size="13" fill="#333">${escSvg(subj)} <tspan fill="#666">${d.percent.toFixed(1)}%</tspan></text>`,
    );
  });

  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="学科分布">` +
    `<text x="${W / 2}" y="32" text-anchor="middle" font-size="17" font-weight="bold" fill="#333">收稿学科分布</text>` +
    paths.join("") +
    legends.join("") +
    `</svg>`
  );
}
