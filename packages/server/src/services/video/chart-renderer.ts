/**
 * Track A.3：把期刊 enricher SVG（IF / CAR / 年发文量 / 引用 Top10）渲染成 PNG，
 * 让 video.sceneType === "data" 的场景能看到真图表。失败 → console.error + 返回 null
 * （caller 跳过该 chart，整个 compose 不因此 500）。
 */
import sharp from "sharp";
import { logger } from "../../config/logger.js";

export type ChartType = "if" | "car" | "volume" | "top10";

export interface ChartSceneData {
  type: ChartType;
  /** 形状随 type：ifHistory / carIndexHistory / publicationStats / citingJournalsTop10 */
  data: unknown;
  width?: number;
  height?: number;
}

export async function renderChartFrame(chart: ChartSceneData): Promise<Buffer | null> {
  const w = chart.width ?? 1080;
  const h = chart.height ?? 1080;
  try {
    const svg = buildChartSvg(chart, w, h);
    if (!svg) return null;
    const buf = await sharp(Buffer.from(svg)).resize(w, h, { fit: "contain", background: "#ffffff" }).png().toBuffer();
    return buf && buf.length > 0 ? buf : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`chart render failed (${chart.type}):`, msg);
    logger.warn({ chartType: chart.type, err: msg }, "video.chart.render.failed");
    return null;
  }
}

function buildChartSvg(chart: ChartSceneData, w: number, h: number): string | null {
  switch (chart.type) {
    case "if": return buildLineSvg(pickHistory(chart.data, "if"), w, h, "近 10 年 IF 历史", "#ef4444");
    case "car": return buildLineSvg(pickHistory(chart.data, "carIndex"), w, h, "近 5 年 CAR 风险趋势", "#3b82f6");
    case "volume": return buildBarSvg(pickHistory(chart.data, "count"), w, h, "年发文量", "#10b981");
    case "top10": return buildTop10Svg(chart.data, w, h);
    default: return null;
  }
}

interface YearValue { year: number; value: number; }

function pickHistory(raw: unknown, key: "if" | "carIndex" | "count"): YearValue[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const arr = Array.isArray(r.data) ? r.data : Array.isArray(r.annualVolumeHistory) ? r.annualVolumeHistory : null;
  if (!arr) return [];
  return arr.flatMap((it) => {
    if (!it || typeof it !== "object") return [];
    const o = it as Record<string, unknown>;
    const y = typeof o.year === "number" ? o.year : null;
    const v = typeof o[key] === "number" ? (o[key] as number) : null;
    return y !== null && v !== null ? [{ year: y, value: v }] : [];
  });
}

function buildLineSvg(points: YearValue[], w: number, h: number, title: string, color: string): string | null {
  if (points.length < 2) return null;
  const padL = 100, padR = 60, padT = 120, padB = 90;
  const iw = w - padL - padR, ih = h - padT - padB;
  const min = Math.min(...points.map(p => p.value)), max = Math.max(...points.map(p => p.value));
  const span = max - min || 1;
  const xs = (i: number) => padL + (i * iw) / (points.length - 1);
  const ys = (v: number) => padT + ih - ((v - min) / span) * ih;
  const poly = points.map((p, i) => `${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(" ");
  const dots = points.map((p, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.value).toFixed(1)}" r="10" fill="${color}"/>`).join("");
  const labels = points.map((p, i) => `<text x="${xs(i).toFixed(1)}" y="${h - 32}" fill="#666" font-size="22" text-anchor="middle">${p.year}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><text x="${w/2}" y="68" fill="#222" font-size="44" font-weight="700" text-anchor="middle">${title}</text><polyline points="${poly}" fill="none" stroke="${color}" stroke-width="6"/>${dots}${labels}<text x="50" y="${padT + 12}" fill="#888" font-size="22">${max.toFixed(2)}</text><text x="50" y="${padT + ih + 4}" fill="#888" font-size="22">${min.toFixed(2)}</text></svg>`;
}

function buildBarSvg(points: YearValue[], w: number, h: number, title: string, color: string): string | null {
  if (points.length === 0) return null;
  const padL = 100, padR = 60, padT = 120, padB = 90;
  const iw = w - padL - padR, ih = h - padT - padB;
  const max = Math.max(...points.map(p => p.value)) || 1;
  const slot = iw / points.length;
  const bw = slot * 0.7;
  const bars = points.map((p, i) => {
    const bh = (p.value / max) * ih;
    const x = padL + i * slot + slot * 0.15;
    return `<rect x="${x.toFixed(1)}" y="${(padT + ih - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"/><text x="${(x + bw/2).toFixed(1)}" y="${h - 32}" fill="#666" font-size="22" text-anchor="middle">${p.year}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><text x="${w/2}" y="68" fill="#222" font-size="44" font-weight="700" text-anchor="middle">${title}</text>${bars}</svg>`;
}

function buildTop10Svg(raw: unknown, w: number, h: number): string | null {
  if (!raw || typeof raw !== "object") return null;
  const arr = (raw as Record<string, unknown>).topJournals;
  if (!Array.isArray(arr)) return null;
  const items = arr.slice(0, 10).flatMap((it) => {
    if (!it || typeof it !== "object") return [];
    const o = it as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : null;
    const count = typeof o.count === "number" ? o.count : null;
    return name && count !== null ? [{ name, count }] : [];
  });
  if (items.length === 0) return null;
  const padL = 240, padR = 120, padT = 130;
  const iw = w - padL - padR, max = Math.max(...items.map(it => it.count));
  const rowH = (h - padT - 60) / items.length;
  const rows = items.map((it, i) => {
    const bw = (it.count / max) * iw;
    const y = padT + i * rowH;
    return `<text x="${padL - 20}" y="${(y + rowH/2 + 8).toFixed(1)}" fill="#333" font-size="22" text-anchor="end">${esc(it.name).slice(0, 18)}</text><rect x="${padL}" y="${(y + rowH*0.2).toFixed(1)}" width="${bw.toFixed(1)}" height="${(rowH*0.6).toFixed(1)}" fill="#f59e0b"/><text x="${(padL + bw + 12).toFixed(1)}" y="${(y + rowH/2 + 8).toFixed(1)}" fill="#666" font-size="20">${it.count}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><text x="${w/2}" y="78" fill="#222" font-size="44" font-weight="700" text-anchor="middle">引用 Top10 期刊</text>${rows}</svg>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
