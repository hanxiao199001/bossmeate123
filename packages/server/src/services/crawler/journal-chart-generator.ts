/**
 * 期刊数据图表生成器
 *
 * 生成 LetPub 风格的 SVG 图表：
 * 1. 近10年影响因子趋势柱状图（蓝色柱子 + 数值标注）
 * 2. 近10年发文量柱状图
 * 3. 期刊分区详情表格（HTML，模拟 LetPub 表格样式）
 *
 * 所有图表用纯 SVG 实现，可直接嵌入微信公众号文章
 */

// ============ 柱状图生成 ============

interface BarChartOptions {
  title: string;
  data: Array<{ label: string; value: number }>;
  color?: string;
  width?: number;
  height?: number;
  valueFormatter?: (v: number) => string;
}

/**
 * 生成蓝色柱状图 SVG（LetPub 风格）
 */
export function generateBarChart(options: BarChartOptions): string {
  const {
    title,
    data,
    color = "#3366cc",
    width = 600,
    height = 320,
    valueFormatter = (v) => v.toString(),
  } = options;

  if (data.length === 0) return "";

  const padding = { top: 55, right: 30, bottom: 40, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxValue = Math.max(...data.map((d) => d.value)) * 1.15;
  const barWidth = Math.min(45, (chartW / data.length) * 0.6);
  const barGap = (chartW - barWidth * data.length) / (data.length + 1);

  // Y 轴刻度
  const yTicks = generateYTicks(maxValue, 5);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:#fff;border:2px solid #ccc;border-radius:4px;">`;

  // 标题（红色粗体，居中）
  svg += `<text x="${width / 2}" y="30" text-anchor="middle" font-family="system-ui,'Microsoft YaHei',sans-serif" font-size="18" font-weight="bold" fill="#cc0000">${escXml(title)}</text>`;

  // Y 轴网格线和刻度
  for (const tick of yTicks) {
    const y = padding.top + chartH - (tick / maxValue) * chartH;
    svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e5e7eb" stroke-width="0.5"/>`;
    svg += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="#666">${tick}</text>`;
  }

  // X 轴基线
  const baseY = padding.top + chartH;
  svg += `<line x1="${padding.left}" y1="${baseY}" x2="${width - padding.right}" y2="${baseY}" stroke="#333" stroke-width="1"/>`;

  // 柱子
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const x = padding.left + barGap + i * (barWidth + barGap);
    const barH = (d.value / maxValue) * chartH;
    const y = baseY - barH;

    // 柱体（蓝色渐变效果用两个矩形模拟）
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" rx="1"/>`;
    // 高光
    svg += `<rect x="${x}" y="${y}" width="${barWidth * 0.4}" height="${barH}" fill="rgba(255,255,255,0.15)" rx="1"/>`;

    // 数值标注（柱子上方）
    svg += `<text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="bold" fill="#333">${valueFormatter(d.value)}</text>`;

    // X 轴标签
    svg += `<text x="${x + barWidth / 2}" y="${baseY + 18}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#666">${escXml(d.label)}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

/**
 * 生成近10年影响因子趋势图
 */
export function generateIFTrendChart(
  ifHistory: Array<{ year: number; value: number }>
): string {
  if (ifHistory.length === 0) return "";

  return generateBarChart({
    title: "近10年的影响因子",
    data: ifHistory.map((h) => ({
      label: h.year.toString(),
      value: h.value,
    })),
    color: "#3366cc",
    valueFormatter: (v) => v.toFixed(v >= 10 ? 1 : 3),
  });
}

/**
 * 生成近10年发文量趋势图
 */
export function generatePubVolumeChart(
  pubHistory: Array<{ year: number; count: number }>
): string {
  if (pubHistory.length === 0) return "";

  return generateBarChart({
    title: "近10年的发文量",
    data: pubHistory.map((h) => ({
      label: h.year.toString(),
      value: h.count,
    })),
    color: "#3366cc",
    valueFormatter: (v) => Math.round(v).toString(),
  });
}

/**
 * 将 SVG 转为 data URI
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

// ============ 分区表格生成（HTML） ============

interface CASPartitionData {
  version: string;
  publishDate?: string;
  majorCategory: string;
  subCategories: Array<{ zone: string; subject: string }>;
  isTop: boolean;
  isReview: boolean;
}

/**
 * 生成中科院分区详情表格 HTML（模拟 LetPub 样式）
 */
export function generateCASPartitionTable(
  partitions: CASPartitionData[]
): string {
  if (partitions.length === 0) return "";

  const rows = partitions.map((p) => {
    const subHtml = p.subCategories
      .map(
        (s) =>
          `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">
            <span style="display:inline-block;padding:1px 8px;background:#e8f0fe;color:#1a56db;font-size:12px;border-radius:3px;font-weight:bold;">${escHtml(s.zone)}</span>
            <span style="font-size:13px;color:#444;">${escHtml(s.subject)}</span>
          </div>`
      )
      .join("");

    return `<tr>
      <td style="padding:12px;border-bottom:1px solid #e5e7eb;vertical-align:top;width:140px;">
        <div style="color:#cc0000;font-weight:bold;font-size:13px;">${escHtml(p.version)}</div>
        ${p.publishDate ? `<div style="font-size:11px;color:#999;">(${escHtml(p.publishDate)})</div>` : ""}
      </td>
      <td style="padding:12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
        <table style="border-collapse:collapse;width:100%;">
          <tr>
            <td style="padding:6px 10px;vertical-align:top;border:1px solid #eee;background:#f9fafb;width:80px;">
              <div style="font-size:12px;color:#666;margin-bottom:2px;">大类</div>
              <div style="font-weight:bold;font-size:13px;">${escHtml(p.majorCategory)}</div>
            </td>
            <td style="padding:6px 10px;vertical-align:top;border:1px solid #eee;background:#f9fafb;">
              <div style="font-size:12px;color:#666;margin-bottom:2px;">小类</div>
              ${subHtml}
            </td>
            <td style="padding:6px 10px;vertical-align:top;border:1px solid #eee;background:#f9fafb;width:70px;text-align:center;">
              <div style="font-size:12px;color:#666;margin-bottom:2px;">TOP期刊</div>
              <div style="font-size:13px;color:${p.isTop ? "#cc0000" : "#333"};font-weight:${p.isTop ? "bold" : "normal"};">${p.isTop ? "是" : "否"}</div>
            </td>
            <td style="padding:6px 10px;vertical-align:top;border:1px solid #eee;background:#f9fafb;width:70px;text-align:center;">
              <div style="font-size:12px;color:#666;margin-bottom:2px;">综述期刊</div>
              <div style="font-size:13px;">${p.isReview ? "是" : "否"}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  });

  return `<table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tbody>
      ${rows.join("")}
    </tbody>
  </table>`;
}

interface JCRPartitionData {
  subject: string;
  database: string;
  zone: string;
  rank: string;
}

/**
 * 生成 JCR/JCI 分区表格 HTML
 */
export function generateJCRPartitionTable(
  partitions: JCRPartitionData[],
  title: string = "JCR学科分类"
): string {
  if (partitions.length === 0) return "";

  const zoneColor: Record<string, string> = {
    Q1: "#16a34a",
    Q2: "#ca8a04",
    Q3: "#ea580c",
    Q4: "#6b7280",
  };

  const headerRow = `<tr style="background:#f0f4f8;">
    <td style="padding:8px 12px;font-weight:bold;color:#1a56db;font-size:13px;border:1px solid #e5e7eb;">${escHtml(title.replace("JCR", "JCR分区").replace("JCI", "JCI分区"))}学科名称</td>
    <td style="padding:8px 12px;font-weight:bold;color:#1a56db;font-size:13px;border:1px solid #e5e7eb;">收录数据库</td>
    <td style="padding:8px 12px;font-weight:bold;color:#1a56db;font-size:13px;border:1px solid #e5e7eb;text-align:center;">${title.includes("JCI") ? "JCI分区" : "JCR分区"}</td>
    <td style="padding:8px 12px;font-weight:bold;color:#1a56db;font-size:13px;border:1px solid #e5e7eb;">分区排名</td>
  </tr>`;

  const dataRows = partitions
    .map((p) => {
      const color = zoneColor[p.zone] || "#6b7280";
      return `<tr>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:13px;">${escHtml(p.subject)}</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:13px;">${escHtml(p.database)}</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;">
        <span style="display:inline-block;padding:2px 10px;background:${color};color:#fff;border-radius:3px;font-size:12px;font-weight:bold;">${escHtml(p.zone)}</span>
      </td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:13px;">${escHtml(p.rank)}</td>
    </tr>`;
    })
    .join("");

  return `<div style="margin-bottom:8px;">
    <div style="color:#1a56db;font-weight:bold;font-size:14px;margin-bottom:6px;">${escHtml(title)}</div>
    <table style="width:100%;border-collapse:collapse;">
      ${headerRow}
      ${dataRows}
    </table>
  </div>`;
}

// ============ 工具函数 ============

function generateYTicks(maxValue: number, count: number): number[] {
  const rawStep = maxValue / count;
  // 取合适的整数步长
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step: number;
  if (rawStep / magnitude < 1.5) step = magnitude;
  else if (rawStep / magnitude < 3.5) step = magnitude * 2;
  else if (rawStep / magnitude < 7.5) step = magnitude * 5;
  else step = magnitude * 10;

  const ticks: number[] = [];
  for (let v = step; v <= maxValue; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

function escXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
