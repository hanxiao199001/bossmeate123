/**
 * 审稿周期柱状图（PR Q.6 D5，E 行业垂直 & B 营销用）
 *
 * 输入：reviewCycle 字符串（如 "2-4 周" / "8-12 周"）
 * 输出：inline SVG 600×220，单柱可视化对比业内（≤4w 快 / 4-12w 中 / >12w 慢）
 * palette 占位 {{PRIMARY}} shunshi replaceAll 注入
 */
import { escSvg } from "./svg-utils.js";

const W = 600, H = 220, PAD_L = 60, PAD_R = 60, BAR_Y = 110, BAR_H = 28;
const FAST_LIMIT = 4, MID_LIMIT = 12, SCALE_MAX = 24; // 周

function parseWeeks(cycle: string): number | null {
  if (!cycle) return null;
  const m = cycle.match(/(\d+)\s*[-~到]\s*(\d+)/);
  if (m) return (parseInt(m[1]) + parseInt(m[2])) / 2;
  const single = cycle.match(/(\d+)/);
  return single ? parseInt(single[1]) : null;
}

export function renderReviewCycleBarChart(reviewCycle: string | null | undefined): string {
  if (!reviewCycle) return "";
  const weeks = parseWeeks(reviewCycle);
  if (weeks == null || weeks <= 0) return "";
  const ratio = Math.min(weeks / SCALE_MAX, 1);
  const barW = W - PAD_L - PAD_R;
  const fillW = barW * ratio;
  const speedLabel = weeks <= FAST_LIMIT ? "极速审稿" : weeks <= MID_LIMIT ? "标准周期" : "审稿较慢";
  // 6-16 手机端: reviewCycle 常是长句(如"网友分享经验：平均3.0个月"), 38px巨字会溢出/换行 → 抽核心时长压缩
  const shortCycle = (() => {
    const m = reviewCycle.match(/(\d+(?:\.\d+)?(?:\s*[-~]\s*\d+(?:\.\d+)?)?)\s*(个?月|周|w|天)/i);
    if (m) return `${m[1].replace(/\s+/g, "")}${m[2]}`;
    return reviewCycle.length > 6 ? reviewCycle.slice(0, 6) : reviewCycle;
  })();

  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="审稿周期 ${weeks} 周">` +
    `<text x="${W / 2}" y="36" text-anchor="middle" font-size="17" font-weight="bold" fill="#333">审稿周期</text>` +
    `<text x="${W / 2}" y="74" text-anchor="middle" font-size="32" font-weight="800" fill="{{PRIMARY}}">${escSvg(shortCycle)}</text>` +
    `<rect x="${PAD_L}" y="${BAR_Y}" width="${barW}" height="${BAR_H}" rx="4" fill="#E0E0E0"/>` +
    `<rect x="${PAD_L}" y="${BAR_Y}" width="${fillW.toFixed(1)}" height="${BAR_H}" rx="4" fill="{{PRIMARY}}"/>` +
    // 业内分段标尺
    `<line x1="${PAD_L + barW * (FAST_LIMIT / SCALE_MAX)}" y1="${BAR_Y - 6}" x2="${PAD_L + barW * (FAST_LIMIT / SCALE_MAX)}" y2="${BAR_Y + BAR_H + 6}" stroke="#666" stroke-dasharray="3,3"/>` +
    `<line x1="${PAD_L + barW * (MID_LIMIT / SCALE_MAX)}" y1="${BAR_Y - 6}" x2="${PAD_L + barW * (MID_LIMIT / SCALE_MAX)}" y2="${BAR_Y + BAR_H + 6}" stroke="#666" stroke-dasharray="3,3"/>` +
    `<text x="${PAD_L}" y="${BAR_Y + BAR_H + 22}" font-size="11" fill="#666">0w</text>` +
    `<text x="${PAD_L + barW * (FAST_LIMIT / SCALE_MAX)}" y="${BAR_Y + BAR_H + 22}" text-anchor="middle" font-size="11" fill="#666">${FAST_LIMIT}w</text>` +
    `<text x="${PAD_L + barW * (MID_LIMIT / SCALE_MAX)}" y="${BAR_Y + BAR_H + 22}" text-anchor="middle" font-size="11" fill="#666">${MID_LIMIT}w</text>` +
    `<text x="${W - PAD_R}" y="${BAR_Y + BAR_H + 22}" text-anchor="end" font-size="11" fill="#666">${SCALE_MAX}w+</text>` +
    `<text x="${W / 2}" y="${BAR_Y + BAR_H + 50}" text-anchor="middle" font-size="14" fill="#666">${escSvg(speedLabel)}</text>` +
    `</svg>`
  );
}
