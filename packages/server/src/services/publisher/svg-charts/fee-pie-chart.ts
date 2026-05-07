/**
 * 出版费 APC 饼图（PR Q.6 D5，B 营销 & E 行业用）
 *
 * 输入：apcFee USD（journal.apcFee）
 * 输出：inline SVG 600×260，2 区饼（vs 行业均值 ~$2500），中心大字数字
 * palette 占位 {{PRIMARY}} / {{ACCENT}} shunshi replaceAll 注入
 */
import { escSvg } from "./svg-utils.js";

const W = 600, H = 260, CX = 200, CY = 130, R = 90;
const BENCHMARK_APC = 2500;  // OA 期刊行业均值粗略基准

export function renderFeePieChart(apcFee: number | null | undefined): string {
  if (apcFee == null || !isFinite(apcFee) || apcFee < 0) return "";
  const ratio = Math.min(apcFee / BENCHMARK_APC, 2);  // 上限 2x 视觉
  // 2 区比例：你的 vs 平均
  const yoursPct = ratio / (ratio + 1);
  const otherPct = 1 - yoursPct;
  const angle = yoursPct * Math.PI * 2;
  const x1 = CX + R * Math.sin(angle);
  const y1 = CY - R * Math.cos(angle);
  const largeArc = angle > Math.PI ? 1 : 0;
  const yoursPath = `M ${CX} ${CY} L ${CX} ${CY - R} A ${R} ${R} 0 ${largeArc} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`;
  const otherPath = `M ${CX} ${CY} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${1 - largeArc} 1 ${CX} ${CY - R} Z`;
  const judge = apcFee < 1500 ? "性价比优" : apcFee < 3000 ? "略高于均值" : "费用较高";

  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="APC 费用 $${apcFee}">` +
    `<text x="${W / 2}" y="32" text-anchor="middle" font-size="17" font-weight="bold" fill="#333">出版费 vs 行业均值</text>` +
    `<path d="${yoursPath}" fill="{{PRIMARY}}" stroke="#fff" stroke-width="2"/>` +
    `<path d="${otherPath}" fill="#E0E0E0" stroke="#fff" stroke-width="2"/>` +
    `<text x="${CX}" y="${CY - 5}" text-anchor="middle" font-size="22" font-weight="800" fill="#fff">$${apcFee}</text>` +
    `<text x="${CX}" y="${CY + 16}" text-anchor="middle" font-size="11" fill="#fff">该刊 APC</text>` +
    // 图例
    `<rect x="340" y="100" width="14" height="14" fill="{{PRIMARY}}"/>` +
    `<text x="362" y="112" font-size="14" fill="#333">该期刊 $${apcFee}</text>` +
    `<rect x="340" y="130" width="14" height="14" fill="#E0E0E0"/>` +
    `<text x="362" y="142" font-size="14" fill="#333">行业均值 $${BENCHMARK_APC}</text>` +
    `<text x="340" y="172" font-size="13" fill="#666">${escSvg(judge)}</text>` +
    `</svg>`
  );
}
