/**
 * Card Generator V2 - Sharp + SVG 生成期刊科普视频各场景底图
 * 每张卡片: 1080×1920 PNG
 * 底部 22%（y ≥ 1497）保留深色区供 FFmpeg 字幕叠加
 */

import sharp from "sharp";

export type SceneType = "opening" | "data" | "review" | "topic" | "tips" | "cta";

export interface JournalCardData {
  name?: string | null;
  nameEn?: string | null;
  impactFactor?: number | null;
  casPartition?: string | null;
  casPartitionNew?: string | null;
  partition?: string | null;
  reviewCycle?: string | null;
  acceptanceRate?: number | null;
  selfCitationRate?: number | null;
  citeScore?: number | null;
  jcrSubjects?: string | null;
  scopeDescription?: string | null;
  discipline?: string | null;
  publisher?: string | null;
}

export async function generateCard(type: SceneType, data: JournalCardData): Promise<Buffer> {
  let svg: string;
  switch (type) {
    case "opening": svg = openingSvg(data); break;
    case "data":    svg = dataSvg(data); break;
    case "review":  svg = reviewSvg(data); break;
    case "topic":   svg = topicSvg(data); break;
    case "tips":    svg = tipsSvg(data); break;
    case "cta":     svg = ctaSvg(data); break;
  }
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function e(s: string | null | undefined): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ifStr(v: number | null | undefined): string {
  return v != null ? v.toFixed(3) : "N/A";
}

function pctStr(v: number | null | undefined): string {
  if (v == null) return "暂缺";
  return (v > 1 ? v : v * 100).toFixed(1) + "%";
}

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) lines.push(text.slice(i, i + maxChars));
  return lines.length ? lines : [""];
}

function parseSubjects(jcr: string | null | undefined): Array<{ subject: string; rank: string }> {
  if (!jcr) return [];
  try {
    const arr = JSON.parse(jcr);
    if (Array.isArray(arr)) {
      return arr.slice(0, 8).map((v: any) => ({
        subject: String(v.subject || "").slice(0, 14),
        rank: String(v.rank || ""),
      }));
    }
  } catch {}
  return [];
}

const FONT = "Noto Sans CJK SC, WenQuanYi Micro Hei, PingFang SC, sans-serif";
const CAPTION_Y = 1497;

function captionBg(): string {
  return `<rect x="0" y="${CAPTION_Y}" width="1080" height="${1920 - CAPTION_Y}" fill="#000000" opacity="0.82"/>`;
}

// ─── Scene 1: Opening ─────────────────────────────────────────────────────────

function openingSvg(d: JournalCardData): string {
  const name = d.name || "期刊";
  const nameEn = e((d.nameEn || "").slice(0, 32));
  const ifVal = e(ifStr(d.impactFactor));
  const partition = d.casPartitionNew || d.casPartition || d.partition || "";
  const category = (d.discipline || "学术期刊").slice(0, 10);

  const nameLines = wrap(name, 11);
  const nl = Math.min(nameLines.length, 2);
  const nameHtml = nameLines.slice(0, 2).map((line, i) =>
    `<text x="540" y="${490 + i * 92}" text-anchor="middle" font-family="${FONT}" font-size="72" fill="white" font-weight="bold">${e(line)}</text>`
  ).join("\n  ");
  const enY = 490 + nl * 92 + 50;
  const cY = enY + 80;

  const badgesHtml = partition
    ? `<rect x="150" y="${cY + 232}" width="260" height="52" rx="26" fill="#4CAF50" opacity="0.9"/>
  <text x="280" y="${cY + 266}" text-anchor="middle" font-family="${FONT}" font-size="28" fill="white" font-weight="bold">${e(partition.slice(0, 8))}</text>
  <rect x="448" y="${cY + 232}" width="382" height="52" rx="26" fill="#2196F3" opacity="0.9"/>
  <text x="639" y="${cY + 266}" text-anchor="middle" font-family="${FONT}" font-size="28" fill="white">${e(category)}</text>`
    : `<rect x="268" y="${cY + 232}" width="544" height="52" rx="26" fill="#2196F3" opacity="0.9"/>
  <text x="540" y="${cY + 266}" text-anchor="middle" font-family="${FONT}" font-size="28" fill="white">${e(category)}</text>`;

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f0c29"/>
      <stop offset="50%" style="stop-color:#302b63"/>
      <stop offset="100%" style="stop-color:#24243e"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <!-- Decorative circles -->
  <circle cx="920" cy="280" r="220" fill="#4a47a3" opacity="0.15"/>
  <circle cx="160" cy="1440" r="160" fill="#4a47a3" opacity="0.10"/>
  <circle cx="1050" cy="1100" r="130" fill="#7c4dff" opacity="0.08"/>
  <!-- Top bar -->
  <rect x="0" y="0" width="1080" height="6" fill="#6c63ff"/>
  <!-- Top badge -->
  <rect x="380" y="256" width="320" height="56" rx="28" fill="#6c63ff" opacity="0.85"/>
  <text x="540" y="294" text-anchor="middle" font-family="${FONT}" font-size="30" fill="white" font-weight="bold">期  刊  推  荐</text>
  <!-- Divider -->
  <line x1="120" y1="374" x2="440" y2="374" stroke="#6c63ff" stroke-width="2" opacity="0.5"/>
  <circle cx="540" cy="374" r="7" fill="#6c63ff" opacity="0.9"/>
  <line x1="640" y1="374" x2="960" y2="374" stroke="#6c63ff" stroke-width="2" opacity="0.5"/>
  <!-- Journal name -->
  ${nameHtml}
  <!-- English name -->
  <text x="540" y="${enY}" text-anchor="middle" font-family="${FONT}" font-size="34" fill="#b8b5ff" opacity="0.9">${nameEn}</text>
  <!-- Data card -->
  <rect x="80" y="${cY}" width="920" height="306" rx="22" fill="white" opacity="0.07"/>
  <rect x="80" y="${cY}" width="920" height="6" rx="3" fill="#ffd700" opacity="0.7"/>
  <text x="540" y="${cY + 72}" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#a5a1ff">影  响  因  子</text>
  <text x="540" y="${cY + 200}" text-anchor="middle" font-family="${FONT}" font-size="104" fill="#ffd700" font-weight="bold" filter="url(#glow)">${ifVal}</text>
  <!-- Partition + Category badges -->
  ${badgesHtml}
  <!-- Bottom accent -->
  <rect x="240" y="1448" width="600" height="4" rx="2" fill="#6c63ff" opacity="0.4"/>
  <text x="540" y="1484" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#666688">学术期刊一站式推荐平台</text>
  ${captionBg()}
</svg>`;
}

// ─── Scene 2: Data ────────────────────────────────────────────────────────────

function dataSvg(d: JournalCardData): string {
  const ifVal = e(ifStr(d.impactFactor));
  const cs = e(d.citeScore != null ? d.citeScore.toFixed(1) : "N/A");
  const casP = e((d.casPartitionNew || d.casPartition || d.partition || "N/A").slice(0, 6));
  const jcrQ = e(d.partition || "");
  const scite = e(pctStr(d.selfCitationRate));
  const pub = e((d.publisher || "").slice(0, 14));
  const journalName = e((d.name || "").slice(0, 16));
  const nameEn = e((d.nameEn || "").slice(0, 28));

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#141e30"/>
      <stop offset="100%" style="stop-color:#243b55"/>
    </linearGradient>
    <linearGradient id="card1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a3a5c"/>
      <stop offset="100%" style="stop-color:#0d2137"/>
    </linearGradient>
    <linearGradient id="card2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#2c1654"/>
      <stop offset="100%" style="stop-color:#160b30"/>
    </linearGradient>
    <linearGradient id="card3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0d3b2e"/>
      <stop offset="100%" style="stop-color:#062318"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <!-- Decorative -->
  <circle cx="1020" cy="500" r="300" fill="#3498db" opacity="0.07"/>
  <circle cx="60" cy="1200" r="200" fill="#2980b9" opacity="0.07"/>
  <!-- Header -->
  <rect x="0" y="0" width="1080" height="210" fill="#1a237e" opacity="0.55"/>
  <rect x="0" y="0" width="1080" height="6" fill="#ffd700"/>
  <text x="540" y="122" text-anchor="middle" font-family="${FONT}" font-size="54" fill="white" font-weight="bold">核  心  数  据</text>
  <text x="540" y="178" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#90caf9">Core Metrics</text>
  <!-- Col 1: IF -->
  <rect x="50" y="240" width="300" height="370" rx="18" fill="url(#card1)" stroke="#3498db" stroke-width="1.5"/>
  <rect x="50" y="240" width="300" height="5" rx="2.5" fill="#3498db"/>
  <text x="200" y="316" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#90caf9">影响因子</text>
  <text x="200" y="448" text-anchor="middle" font-family="${FONT}" font-size="82" fill="#ffd700" font-weight="bold" filter="url(#glow)">${ifVal}</text>
  <text x="200" y="512" text-anchor="middle" font-family="${FONT}" font-size="22" fill="#607d8b">Impact Factor</text>
  <rect x="88" y="548" width="224" height="36" rx="18" fill="#3498db" opacity="0.6"/>
  <text x="200" y="572" text-anchor="middle" font-family="${FONT}" font-size="22" fill="white">IF ${ifVal}</text>
  <!-- Col 2: CiteScore -->
  <rect x="390" y="240" width="300" height="370" rx="18" fill="url(#card2)" stroke="#9c27b0" stroke-width="1.5"/>
  <rect x="390" y="240" width="300" height="5" rx="2.5" fill="#9c27b0"/>
  <text x="540" y="316" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#ce93d8">CiteScore</text>
  <text x="540" y="448" text-anchor="middle" font-family="${FONT}" font-size="82" fill="#80cbc4" font-weight="bold" filter="url(#glow)">${cs}</text>
  <text x="540" y="512" text-anchor="middle" font-family="${FONT}" font-size="22" fill="#607d8b">引用分数</text>
  <rect x="428" y="548" width="224" height="36" rx="18" fill="#9c27b0" opacity="0.6"/>
  <text x="540" y="572" text-anchor="middle" font-family="${FONT}" font-size="22" fill="white">CiteScore</text>
  <!-- Col 3: Partition -->
  <rect x="730" y="240" width="300" height="370" rx="18" fill="url(#card3)" stroke="#4caf50" stroke-width="1.5"/>
  <rect x="730" y="240" width="300" height="5" rx="2.5" fill="#4caf50"/>
  <text x="880" y="316" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#a5d6a7">中科院分区</text>
  <text x="880" y="430" text-anchor="middle" font-family="${FONT}" font-size="70" fill="#69f0ae" font-weight="bold">${casP}</text>
  <text x="880" y="512" text-anchor="middle" font-family="${FONT}" font-size="22" fill="#607d8b">CAS Partition</text>
  ${jcrQ ? `<rect x="768" y="548" width="224" height="36" rx="18" fill="#4caf50" opacity="0.6"/>
  <text x="880" y="572" text-anchor="middle" font-family="${FONT}" font-size="22" fill="white">JCR ${jcrQ}</text>` : ""}
  <!-- Row 2: Self-citation + Publisher -->
  <rect x="50" y="650" width="465" height="168" rx="14" fill="white" opacity="0.05"/>
  <text x="110" y="714" font-family="${FONT}" font-size="26" fill="#90caf9">自 引 率</text>
  <text x="110" y="796" font-family="${FONT}" font-size="58" fill="#f8bbd0" font-weight="bold">${scite}</text>
  ${d.publisher ? `
  <rect x="565" y="650" width="465" height="168" rx="14" fill="white" opacity="0.05"/>
  <text x="622" y="714" font-family="${FONT}" font-size="26" fill="#90caf9">出 版 商</text>
  <text x="622" y="778" font-family="${FONT}" font-size="36" fill="white">${pub}</text>` : ""}
  <!-- Journal name strip -->
  <rect x="50" y="860" width="980" height="126" rx="14" fill="white" opacity="0.05"/>
  <text x="540" y="922" text-anchor="middle" font-family="${FONT}" font-size="46" fill="white" font-weight="bold">${journalName}</text>
  <text x="540" y="970" text-anchor="middle" font-family="${FONT}" font-size="28" fill="#90caf9">${nameEn}</text>
  <!-- Bottom -->
  <rect x="240" y="1448" width="600" height="4" rx="2" fill="#3498db" opacity="0.4"/>
  <text x="540" y="1484" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#546e7a">期刊核心数据一览</text>
  ${captionBg()}
</svg>`;
}

// ─── Scene 3: Review ──────────────────────────────────────────────────────────

function reviewSvg(d: JournalCardData): string {
  const cycle = e((d.reviewCycle || "暂缺数据").slice(0, 12));
  const accStr = e(pctStr(d.acceptanceRate));
  const accNum = d.acceptanceRate != null
    ? Math.min(100, d.acceptanceRate > 1 ? d.acceptanceRate : d.acceptanceRate * 100)
    : null;
  const scite = e(pctStr(d.selfCitationRate));
  const pub = e((d.publisher || "暂缺").slice(0, 20));
  const barMaxW = 800;
  const barFill = accNum != null ? Math.round(accNum / 100 * barMaxW) : 0;

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f3460"/>
      <stop offset="50%" style="stop-color:#16213e"/>
      <stop offset="100%" style="stop-color:#0a1628"/>
    </linearGradient>
    <linearGradient id="barGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#43a047"/>
      <stop offset="100%" style="stop-color:#a5d6a7"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <!-- Decorative -->
  <circle cx="960" cy="960" r="400" fill="#1565c0" opacity="0.08"/>
  <circle cx="120" cy="400" r="180" fill="#0288d1" opacity="0.07"/>
  <!-- Header -->
  <rect x="0" y="0" width="1080" height="6" fill="#43a047"/>
  <rect x="0" y="0" width="1080" height="210" fill="#0d2137" opacity="0.6"/>
  <text x="540" y="122" text-anchor="middle" font-family="${FONT}" font-size="54" fill="white" font-weight="bold">审  稿  信  息</text>
  <text x="540" y="178" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#4fc3f7">Review Efficiency</text>
  <!-- Item 1: Review Cycle -->
  <rect x="60" y="240" width="960" height="230" rx="18" fill="white" opacity="0.06"/>
  <rect x="60" y="240" width="960" height="5" rx="2.5" fill="#43a047"/>
  <circle cx="130" cy="355" r="45" fill="#43a047" opacity="0.85"/>
  <text x="130" y="365" text-anchor="middle" font-family="${FONT}" font-size="36" fill="white" font-weight="bold">1</text>
  <text x="210" y="318" font-family="${FONT}" font-size="28" fill="#a5d6a7">审稿周期</text>
  <text x="210" y="400" font-family="${FONT}" font-size="64" fill="white" font-weight="bold">${cycle}</text>
  <!-- Item 2: Acceptance Rate -->
  <rect x="60" y="504" width="960" height="280" rx="18" fill="white" opacity="0.06"/>
  <rect x="60" y="504" width="960" height="5" rx="2.5" fill="#2196F3"/>
  <circle cx="130" cy="620" r="45" fill="#2196F3" opacity="0.85"/>
  <text x="130" y="630" text-anchor="middle" font-family="${FONT}" font-size="36" fill="white" font-weight="bold">2</text>
  <text x="210" y="584" font-family="${FONT}" font-size="28" fill="#90caf9">录用率</text>
  <text x="210" y="668" font-family="${FONT}" font-size="72" fill="white" font-weight="bold">${accStr}</text>
  <!-- Progress bar -->
  <rect x="140" y="718" width="${barMaxW}" height="24" rx="12" fill="white" opacity="0.12"/>
  ${barFill > 0 ? `<rect x="140" y="718" width="${barFill}" height="24" rx="12" fill="url(#barGrad)"/>` : ""}
  <!-- Item 3: Self-citation -->
  <rect x="60" y="820" width="460" height="200" rx="18" fill="white" opacity="0.05"/>
  <rect x="60" y="820" width="460" height="5" rx="2.5" fill="#ff9800"/>
  <circle cx="130" cy="920" r="40" fill="#ff9800" opacity="0.85"/>
  <text x="130" y="930" text-anchor="middle" font-family="${FONT}" font-size="32" fill="white" font-weight="bold">3</text>
  <text x="208" y="888" font-family="${FONT}" font-size="26" fill="#ffcc80">自引率</text>
  <text x="208" y="970" font-family="${FONT}" font-size="56" fill="white" font-weight="bold">${scite}</text>
  <!-- Item 4: Publisher -->
  <rect x="560" y="820" width="460" height="200" rx="18" fill="white" opacity="0.05"/>
  <rect x="560" y="820" width="460" height="5" rx="2.5" fill="#9c27b0"/>
  <circle cx="630" cy="920" r="40" fill="#9c27b0" opacity="0.85"/>
  <text x="630" y="930" text-anchor="middle" font-family="${FONT}" font-size="32" fill="white" font-weight="bold">4</text>
  <text x="706" y="888" font-family="${FONT}" font-size="26" fill="#ce93d8">出版商</text>
  <text x="706" y="960" font-family="${FONT}" font-size="38" fill="white">${pub}</text>
  <!-- Note -->
  <text x="540" y="1080" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#546e7a">* 以上数据基于历史平均值，仅供参考</text>
  <!-- Bottom -->
  <rect x="240" y="1448" width="600" height="4" rx="2" fill="#43a047" opacity="0.4"/>
  <text x="540" y="1484" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#546e7a">审稿效率综合评估</text>
  ${captionBg()}
</svg>`;
}

// ─── Scene 4: Topic ───────────────────────────────────────────────────────────

function topicSvg(d: JournalCardData): string {
  const scope = (d.scopeDescription || "").slice(0, 160);
  const subjects = parseSubjects(d.jcrSubjects);
  const scopeLines = wrap(scope, 22);
  const scopeHtml = scope
    ? scopeLines.slice(0, 4).map((line, i) =>
        `<text x="540" y="${396 + i * 60}" text-anchor="middle" font-family="${FONT}" font-size="36" fill="#e1d5ff">${e(line)}</text>`
      ).join("\n  ")
    : `<text x="540" y="440" text-anchor="middle" font-family="${FONT}" font-size="36" fill="#7e57c2">暂无收稿范围描述</text>
  <text x="540" y="500" text-anchor="middle" font-family="${FONT}" font-size="32" fill="#546e7a">请访问期刊官网获取详情</text>`;

  const scopeBoxH = scope ? Math.min(scopeLines.length, 4) * 60 + 60 : 120;

  const tagColors = ["#7c4dff", "#651fff", "#512da8", "#4527a0", "#6200ea", "#311b92", "#aa00ff", "#7b1fa2"];
  const tagsHtml = subjects.map((s, i) => {
    const col = i % 2 === 0 ? 0 : 1;
    const row = Math.floor(i / 2);
    const tx = col === 0 ? 150 : 590;
    const ty = (scope ? 240 + scopeBoxH + 160 : 540) + row * 130;
    const w = 380;
    const label = (s.rank ? s.rank + " " : "") + s.subject;
    return `<rect x="${tx - w / 2}" y="${ty - 42}" width="${w}" height="84" rx="42" fill="${tagColors[i % tagColors.length]}" opacity="0.85"/>
  <text x="${tx}" y="${ty + 14}" text-anchor="middle" font-family="${FONT}" font-size="30" fill="white" font-weight="bold">${e(label)}</text>`;
  }).join("\n  ");

  const subjectLabelY = scope ? 240 + scopeBoxH + 88 : 498;

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a0033"/>
      <stop offset="50%" style="stop-color:#311b69"/>
      <stop offset="100%" style="stop-color:#1a0040"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <!-- Decorative -->
  <circle cx="900" cy="200" r="300" fill="#6a1b9a" opacity="0.10"/>
  <circle cx="180" cy="1300" r="200" fill="#4a148c" opacity="0.08"/>
  <circle cx="540" cy="760" r="500" fill="#311b92" opacity="0.05"/>
  <!-- Header -->
  <rect x="0" y="0" width="1080" height="6" fill="#9c27b0"/>
  <rect x="0" y="0" width="1080" height="210" fill="#12002a" opacity="0.7"/>
  <text x="540" y="122" text-anchor="middle" font-family="${FONT}" font-size="54" fill="white" font-weight="bold">收  稿  方  向</text>
  <text x="540" y="178" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#ce93d8">Research Scope</text>
  <!-- Scope description block -->
  <rect x="60" y="232" width="960" height="${scopeBoxH}" rx="18" fill="white" opacity="0.05"/>
  <rect x="60" y="232" width="960" height="5" rx="2.5" fill="#9c27b0" opacity="0.7"/>
  ${scopeHtml}
  <!-- JCR Subjects label -->
  ${subjects.length > 0 ? `
  <rect x="340" y="${subjectLabelY - 38}" width="400" height="56" rx="28" fill="#9c27b0" opacity="0.55"/>
  <text x="540" y="${subjectLabelY}" text-anchor="middle" font-family="${FONT}" font-size="28" fill="white" font-weight="bold">JCR 学科分区</text>
  ${tagsHtml}` : ""}
  <!-- Bottom -->
  <rect x="240" y="1448" width="600" height="4" rx="2" fill="#9c27b0" opacity="0.4"/>
  <text x="540" y="1484" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#546e7a">期刊收稿范围参考</text>
  ${captionBg()}
</svg>`;
}

// ─── Scene 5: Tips ────────────────────────────────────────────────────────────

function tipsSvg(d: JournalCardData): string {
  const ifVal = ifStr(d.impactFactor);
  const partStr = d.casPartitionNew || d.casPartition || d.partition || "";
  const discipline = (d.discipline || "本领域").slice(0, 6);
  const badge = e([ifVal !== "N/A" ? `IF ${ifVal}` : "", partStr].filter(Boolean).join("  ·  "));

  const tips = [
    { num: "1", title: "选题匹配", body: `紧贴${discipline}核心研究方向，避免偏题`, color: "#e91e63", light: "#fce4ec" },
    { num: "2", title: "格式规范", body: "图表分辨率 ≥300 DPI，严格遵守作者须知", color: "#ff9800", light: "#fff3e0" },
    { num: "3", title: "参考文献", body: "格式须与期刊要求完全一致，勿用自动工具", color: "#009688", light: "#e0f2f1" },
    { num: "4", title: "语言润色", body: "投稿前建议委托专业机构进行学术英语润色", color: "#3f51b5", light: "#e8eaf6" },
  ];

  const tipsHtml = tips.map((tip, i) => {
    const ty = 310 + i * 240;
    const bodyLines = wrap(tip.body, 18);
    const bodyHtml = bodyLines.slice(0, 2).map((line, li) =>
      `<text x="230" y="${ty + 90 + li * 56}" font-family="${FONT}" font-size="34" fill="#e0e0e0">${e(line)}</text>`
    ).join("\n    ");
    return `<rect x="60" y="${ty}" width="960" height="${Math.max(168, bodyLines.slice(0, 2).length * 56 + 100)}" rx="16" fill="${tip.color}" opacity="0.12"/>
  <rect x="60" y="${ty}" width="960" height="6" rx="3" fill="${tip.color}"/>
  <circle cx="145" cy="${ty + 80}" r="50" fill="${tip.color}" opacity="0.9"/>
  <text x="145" y="${ty + 92}" text-anchor="middle" font-family="${FONT}" font-size="42" fill="white" font-weight="bold">${tip.num}</text>
  <text x="230" y="${ty + 56}" font-family="${FONT}" font-size="34" fill="${tip.color}" font-weight="bold">${tip.title}</text>
    ${bodyHtml}`;
  }).join("\n  ");

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a0000"/>
      <stop offset="50%" style="stop-color:#3b1515"/>
      <stop offset="100%" style="stop-color:#0d0d0d"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <!-- Decorative -->
  <circle cx="960" cy="280" r="220" fill="#c62828" opacity="0.08"/>
  <circle cx="120" cy="1350" r="180" fill="#b71c1c" opacity="0.07"/>
  <!-- Header -->
  <rect x="0" y="0" width="1080" height="6" fill="#ef5350"/>
  <rect x="0" y="0" width="1080" height="210" fill="#1a0000" opacity="0.65"/>
  <text x="540" y="122" text-anchor="middle" font-family="${FONT}" font-size="54" fill="white" font-weight="bold">投  稿  建  议</text>
  <text x="540" y="178" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#ef9a9a">Submission Tips</text>
  ${badge ? `<text x="540" y="278" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#9e9e9e">${badge}</text>` : ""}
  <!-- Tips -->
  ${tipsHtml}
  <!-- Bottom -->
  <rect x="240" y="1448" width="600" height="4" rx="2" fill="#ef5350" opacity="0.4"/>
  <text x="540" y="1484" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#546e7a">投稿成功四大关键要素</text>
  ${captionBg()}
</svg>`;
}

// ─── Scene 6: CTA ─────────────────────────────────────────────────────────────

function ctaSvg(d: JournalCardData): string {
  const name = (d.name || "").slice(0, 14);
  const ifVal = ifStr(d.impactFactor);
  const partStr = d.casPartitionNew || d.casPartition || d.partition || "";
  const badge = e([ifVal !== "N/A" ? `IF ${ifVal}` : "", partStr].filter(Boolean).join("  ·  "));
  const nameLines = wrap(name, 11);
  const nameHtml = nameLines.slice(0, 2).map((line, i) =>
    `<text x="540" y="${218 + i * 92}" text-anchor="middle" font-family="${FONT}" font-size="76" fill="white" font-weight="bold">${e(line)}</text>`
  ).join("\n  ");
  const afterNameY = 218 + Math.min(nameLines.length, 2) * 92;

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#b71c1c"/>
      <stop offset="40%" style="stop-color:#880e4f"/>
      <stop offset="100%" style="stop-color:#4a148c"/>
    </linearGradient>
    <linearGradient id="btnGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#ff6b6b"/>
      <stop offset="100%" style="stop-color:#ffa07a"/>
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="120%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000000" flood-opacity="0.4"/>
    </filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <!-- Decorative -->
  <circle cx="540" cy="820" r="680" fill="white" opacity="0.03"/>
  <circle cx="980" cy="220" r="200" fill="#ff1744" opacity="0.10"/>
  <circle cx="100" cy="1350" r="180" fill="#d500f9" opacity="0.08"/>
  <!-- Top bar -->
  <rect x="0" y="0" width="1080" height="6" fill="#ff5252"/>
  <!-- Journal name -->
  ${nameHtml}
  <!-- Badge row -->
  ${badge ? `<text x="540" y="${afterNameY + 50}" text-anchor="middle" font-family="${FONT}" font-size="36" fill="#ffcdd2" opacity="0.9">${badge}</text>` : ""}
  <!-- Main CTA card -->
  <rect x="80" y="${afterNameY + 120}" width="920" height="380" rx="24" fill="white" opacity="0.10" filter="url(#shadow)"/>
  <rect x="80" y="${afterNameY + 120}" width="920" height="5" rx="2.5" fill="#ff5252"/>
  <text x="540" y="${afterNameY + 202}" text-anchor="middle" font-family="${FONT}" font-size="44" fill="white" font-weight="bold">想了解更多期刊分析？</text>
  <text x="540" y="${afterNameY + 270}" text-anchor="middle" font-family="${FONT}" font-size="38" fill="#ffcdd2">关注主页  ·  私信咨询</text>
  <!-- Sub tags -->
  <rect x="155" y="${afterNameY + 306}" width="240" height="54" rx="27" fill="#ff5252" opacity="0.75"/>
  <text x="275" y="${afterNameY + 340}" text-anchor="middle" font-family="${FONT}" font-size="26" fill="white">投稿方案</text>
  <rect x="430" y="${afterNameY + 306}" width="220" height="54" rx="27" fill="#e91e63" opacity="0.75"/>
  <text x="540" y="${afterNameY + 340}" text-anchor="middle" font-family="${FONT}" font-size="26" fill="white">期刊速览</text>
  <rect x="685" y="${afterNameY + 306}" width="240" height="54" rx="27" fill="#9c27b0" opacity="0.75"/>
  <text x="805" y="${afterNameY + 340}" text-anchor="middle" font-family="${FONT}" font-size="26" fill="white">影响因子</text>
  <text x="540" y="${afterNameY + 426}" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#ef9a9a">每日更新  ·  专业解读  ·  持续分享</text>
  <!-- Follow button -->
  <rect x="240" y="${afterNameY + 560}" width="600" height="90" rx="45" fill="url(#btnGrad)" filter="url(#shadow)"/>
  <text x="540" y="${afterNameY + 618}" text-anchor="middle" font-family="${FONT}" font-size="38" fill="white" font-weight="bold">立 即 关 注</text>
  <!-- Divider -->
  <rect x="240" y="1448" width="600" height="4" rx="2" fill="#ff5252" opacity="0.4"/>
  <text x="540" y="1484" text-anchor="middle" font-family="${FONT}" font-size="26" fill="#9e9e9e">学术期刊一站式推荐平台</text>
  ${captionBg()}
</svg>`;
}
