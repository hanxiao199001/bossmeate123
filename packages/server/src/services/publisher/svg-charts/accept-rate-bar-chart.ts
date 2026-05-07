/**
 * 录用率柱状图（PR Q.6 D5，shunshi-style 区块 — B 营销 & E 行业用）
 *
 * 输入：acceptanceRate（0-1 或 0-100，自动归一化）
 * 输出：inline SVG 600×220，横向单柱（数据比例）+ 大数字
 * palette 占位：{{PRIMARY}} / {{ACCENT}} 末尾 shunshi replaceAll 注入
 */
import { escSvg } from "./svg-utils.js";

const W = 600, H = 220, PAD_L = 40, PAD_R = 40, BAR_H = 36, BAR_Y = 110;
const BAR_FILL = "{{PRIMARY}}";
const BAR_BG = "#E0E0E0";

export function renderAcceptRateBarChart(acceptanceRate: number | null | undefined): string {
  if (acceptanceRate == null || !isFinite(acceptanceRate)) return "";
  const rate = acceptanceRate >= 1 ? Math.min(acceptanceRate, 100) : acceptanceRate * 100;
  const pct = rate.toFixed(1);
  const barW = W - PAD_L - PAD_R;
  const fillW = (barW * rate) / 100;
  const label = rate < 5 ? "极难录用" : rate < 15 ? "录用率较低" : rate < 30 ? "录用率适中" : "录用率友好";

  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="录用率 ${pct}%">` +
    `<text x="${W / 2}" y="40" text-anchor="middle" font-size="18" font-weight="bold" fill="#333">期刊录用率</text>` +
    `<text x="${W / 2}" y="78" text-anchor="middle" font-size="44" font-weight="800" fill="${BAR_FILL}">${pct}%</text>` +
    `<rect x="${PAD_L}" y="${BAR_Y}" width="${barW}" height="${BAR_H}" rx="6" fill="${BAR_BG}"/>` +
    `<rect x="${PAD_L}" y="${BAR_Y}" width="${fillW.toFixed(1)}" height="${BAR_H}" rx="6" fill="${BAR_FILL}"/>` +
    `<text x="${PAD_L}" y="${BAR_Y + BAR_H + 24}" font-size="13" fill="#666">0%</text>` +
    `<text x="${W - PAD_R}" y="${BAR_Y + BAR_H + 24}" text-anchor="end" font-size="13" fill="#666">100%</text>` +
    `<text x="${W / 2}" y="${BAR_Y + BAR_H + 50}" text-anchor="middle" font-size="14" fill="#666">${escSvg(label)}</text>` +
    `</svg>`
  );
}
