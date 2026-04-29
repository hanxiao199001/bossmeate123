/**
 * SVG charts shared helpers (C 阶段)
 *
 * 微信公众号 inline SVG 兼容约束：
 *  - 仅基本几何（rect / circle / line / polyline / path / text / g）
 *  - inline style 内联（class/<style> 不保证生效）
 *  - viewBox 必须；width/height 让微信渲染端自适应
 *  - 不依赖外部字体（让微信渲染端用默认字体）
 */

/** 转义 SVG 文本节点（防止 < / > / & 破坏 markup） */
export function escSvg(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 数值格式化：> 100 整数；> 10 一位小数；其余两位小数 */
export function fmtValue(v: number): string {
  if (!isFinite(v)) return "—";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** 把数值数组映射到 [yBottom, yTop] 像素坐标（svg y 轴反向） */
export function scaleY(value: number, vMin: number, vMax: number, yBottom: number, yTop: number): number {
  if (vMax === vMin) return (yBottom + yTop) / 2;
  const ratio = (value - vMin) / (vMax - vMin);
  return yBottom - ratio * (yBottom - yTop);
}
