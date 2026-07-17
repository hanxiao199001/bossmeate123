/**
 * 7-18 效果看板 — 纯函数 (无 IO/db/env 依赖, 可直接单测)。
 * 从 effect-dashboard.ts 拆出, 便于 vitest 无需 mock db/env 即测趋势补零 / 覆盖率。
 */

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  reads: number;
}

/** YYYY-MM-DD (UTC) */
export function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 趋势补零: 把稀疏的"某几天有阅读"补成连续 N 天 (缺的天 = 0), 供折线连续绘制。
 * @param rows    已有数据 [{date, reads}] (date=YYYY-MM-DD, 可乱序/有缺失/重复)
 * @param endDate 区间末日 (含), 通常今天
 * @param days    连续天数 (7/30/90)
 * @returns 长度=days 的连续序列, 按日期升序
 */
export function fillTrendZeros(
  rows: Array<{ date: string; reads: number }>,
  endDate: Date,
  days: number,
): TrendPoint[] {
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + (r.reads ?? 0));
  const out: TrendPoint[] = [];
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400_000);
    const key = toDateStr(d);
    out.push({ date: key, reads: byDate.get(key) ?? 0 });
  }
  return out;
}

/** 覆盖率算法: measured/published → 0-100 整数; 无发布记录 (published<=0) → null (不是 0%, 避免误导) */
export function computeCoverage(measuredCount: number, publishedCount: number): number | null {
  if (publishedCount <= 0) return null;
  return Math.min(100, Math.round((measuredCount / publishedCount) * 100));
}
