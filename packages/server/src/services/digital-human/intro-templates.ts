/**
 * 7-10 混剪片头模板池 — 治"千篇一律"：老韩看样片说片头只有一种版式(封面铺底+居中标题)没新意。
 * 做成 4 套模板, seed + clipStyle 加权选择, 同内容不同账号(不同 seed)片头版式也不同 = 防查重属性顺带加强。
 *
 *   A 现款     封面铺满压暗 + 居中大标题(原版式原样保留, 老观感兜底)
 *   B 色块标题条 封面占上 2/3, 下 1/3 纯色色块承载左对齐标题 + 点缀色条(更有设计感)
 *   C 数据大字卡 深色底, IF/分区超大数字当视觉主角, 标题小字在下 — 期刊数据是产品卖点, 让它当主角
 *   D 大字报    无图纯排版, 超大标题拆行 + 下划线色条, 专治无封面的刊(原来只能纯色+小标题)
 *
 * 为什么独立成模块: ① 便于扩第 5/6 套模板(只加 case); ② 零重依赖(不 import env/storage/logger),
 *   单测和沙盒真烧帧脚本都能直接 import, 不用 mock 整套服务端配置。
 */

export type IntroTemplate = "A" | "B" | "C" | "D";

/** 点缀色(色条/大字): 比 INTRO_COLORS 亮, 在深底上跳出来。seed 随机选 → 又一层防查重变化。 */
export const ACCENT_COLORS = ["0xffd166", "0x4cc9f0", "0x06d6a0", "0xef476f", "0xf4a261"];

/** drawtext 不能安全带引号/反斜杠/冒号(滤镜分隔符), 统一清洗 + 截 26 字(片头放不下更长)。 */
export const sanitizeDrawtext = (s: string) => s.replace(/'/g, "").replace(/[\\:]/g, " ").slice(0, 26);

/**
 * 标题断行(原 video-remix.wrapIntroTitle 原样搬入, 行为不变): ≤14 字单行, 否则 13 字断两行。
 * A/降级图沿用它; B/C/D 用下方 wrapTitle 按各自版式的行宽断。
 */
export function wrapIntroTitle(title: string): string {
  const t = sanitizeDrawtext(title || "");
  if (t.length <= 14) return t;
  const head = t.slice(0, 13);
  const tail = t.slice(13);
  return `${head}\n${tail}`;
}

/**
 * 通用断行: 每行 perLine 字、最多 maxLines 行(超出截断) — 不同模板行宽不同(D 超大字一行只放得下 8 字)。
 * 7-08 防孤字行: 末行只剩 1 字("...连涨五/年")很难看 — 断点回退 1, 让末行至少 2 字。
 */
export function wrapTitle(title: string, perLine: number, maxLines: number): string {
  const t = sanitizeDrawtext(title || "");
  // 会产生孤字末行时, 整体每行少切 1 字(首行 12+2 比 13+1 好看)
  const orphan = t.length > perLine && t.length % perLine === 1 && Math.ceil(t.length / perLine) <= maxLines;
  const per = orphan && perLine > 2 ? perLine - 1 : perLine;
  const lines: string[] = [];
  for (let i = 0; i < t.length && lines.length < maxLines; i += per) {
    lines.push(t.slice(i, i + per));
  }
  return lines.join("\n") || t;
}

/** 各模板的标题断行规格(与字号联动: 字越大每行越少, 保证不出画)。 */
export function wrapTitleForTemplate(template: IntroTemplate, title: string): string {
  switch (template) {
    case "B": return wrapTitle(title, 12, 2);  // 左对齐 w/15 字号, 12 字*0.072w ≈ 0.86w 留边距
    case "C": return wrapTitle(title, 13, 2);  // 标题是配角小字, 沿用 13 字两行
    case "D": return wrapTitle(title, 8, 3);   // 超大字 w/10, 8 字*0.1w = 0.8w 正好大而不溢
    default: return wrapIntroTitle(title);      // A/降级 = 原行为
  }
}

export interface IntroFilterCtx {
  w: number;
  h: number;
  font: string;         // 字体文件路径
  introColor: string;   // 底色 0xRRGGBB(B 的下 1/3 色块 / C/D 的全屏底 / A 无图兜底)
  accentColor: string;  // 点缀色(色条/大字)
  titleFile: string;    // 标题 textfile 路径(调用方已按 wrapTitleForTemplate 断行写盘)
  titleLines: number;   // 标题行数(D 要靠它算下划线色条的 y, drawbox 拿不到 text_h)
  hasImage: boolean;    // [1:v] 是否图片输入(封面); 只有 A/B 用图, C/D 恒为 lavfi 纯色
  stats?: { bigFile: string; bigText: string; smallFile?: string; smallText?: string }; // C 的数据主角
}

/**
 * 按文本估宽自适应字号: CJK 全角 ≈ 1em, ASCII 半角 ≈ 0.58em。
 * 为什么要估: drawtext 的 fontsize 是静态参数, 不能"超宽自动缩", 而 IF 文本长度不定
 * ("IF 5.2" vs "中科院医学1区"), 不估宽就会溢出画面。
 */
function fitFont(text: string, maxPx: number, basePx: number): number {
  const units = [...text].reduce((s, ch) => s + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.58), 0);
  return Math.max(18, Math.min(basePx, Math.floor(maxPx / Math.max(units, 0.5))));
}

const even = (n: number) => 2 * Math.ceil(n / 2); // yuv420p 尺寸必须偶数

/**
 * seed + clipStyle 加权选模板:
 *   有封面 → A/B/C 轮换(C 需有数据); 无封面 → C/D(C 需有数据, 都没有兜 D)。
 *   clipStyle=data 数据号 → C 权重 +4(数据是它的人设); marketing 引流号 → B 权重 +3(设计感/转化)。
 * r 是 seed 驱动的确定性随机 → 同 seed 同模板, 保持"同内容不同账号不同成片"。
 */
export function pickIntroTemplate(
  r: () => number,
  o: { hasCover: boolean; hasStats: boolean; clipStyle?: string },
): IntroTemplate {
  const pool: Array<[IntroTemplate, number]> = [];
  if (o.hasCover) {
    pool.push(["A", 3], ["B", 3]);
    if (o.hasStats) pool.push(["C", 2]);
  } else {
    if (o.hasStats) pool.push(["C", 3]);
    pool.push(["D", 4]);
  }
  const bump = (t: IntroTemplate, n: number) => {
    const e = pool.find((x) => x[0] === t);
    if (e) e[1] += n;
  };
  if (o.clipStyle === "data") bump("C", 4);
  if (o.clipStyle === "marketing") bump("B", 3);

  const total = pool.reduce((s, [, n]) => s + n, 0);
  let roll = r() * total;
  for (const [k, n] of pool) {
    roll -= n;
    if (roll < 0) return k;
  }
  return pool[pool.length - 1]![0];
}

/**
 * 生成片头滤镜链: 输入 [1:v](图片流或 lavfi 纯色, 由 hasImage 区分) → 输出 [intro]。
 * 所有模板统一 fps=25 / yuv420p / fade in 0.4s / settb=AVTB(与主轴 xfade 对齐, 时间基不一致会崩)。
 */
export function buildIntroFilter(template: IntroTemplate, ctx: IntroFilterCtx): string {
  const { w, h, font, introColor, accentColor, titleFile, titleLines, hasImage, stats } = ctx;

  // ---- A 现款(原样保留, 老观感兜底; B/C 素材缺失也降到这里) ----
  const buildA = (): string => {
    const fs = Math.round(w / 14);
    const bw = Math.max(2, Math.round(w / 270)); // 1080 宽 ≈ 4px 黑描边
    const draw = `drawtext=fontfile='${font}':textfile='${titleFile}':fontcolor=white:fontsize=${fs}:borderw=${bw}:bordercolor=black:line_spacing=${Math.round(w / 90)}:x=(w-text_w)/2:y=(h-text_h)/2`;
    return hasImage
      ? `[1:v]fps=25,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},eq=brightness=-0.28,setsar=1,format=yuv420p,${draw},fade=t=in:d=0.4,settb=AVTB[intro];`
      : `[1:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,${draw},fade=t=in:d=0.4,settb=AVTB[intro];`;
  };

  switch (template) {
    case "B": {
      if (!hasImage) return buildA(); // B 没图无从谈"上 2/3 封面", 防御性兜 A 纯色
      const h23 = even(Math.round((h * 2) / 3));
      const x = Math.round(w * 0.07);
      const fs = Math.round(w / 15);
      const barH = Math.max(6, Math.round(h / 160));
      // 封面裁满上 2/3 → pad 补出下 1/3 纯色块 → 色块顶部一根点缀色条 → 标题左对齐垂直居中于色块
      const draw = `drawtext=fontfile='${font}':textfile='${titleFile}':fontcolor=white:fontsize=${fs}:line_spacing=${Math.round(w / 70)}:x=${x}:y=${h23}+(${h - h23}-text_h)/2`;
      return (
        `[1:v]fps=25,scale=${w}:${h23}:force_original_aspect_ratio=increase,crop=${w}:${h23},setsar=1,` +
        `pad=${w}:${h}:0:0:color=${introColor},format=yuv420p,` +
        `drawbox=x=${x}:y=${h23 + Math.round(h * 0.02)}:w=${Math.round(w * 0.13)}:h=${barH}:color=${accentColor}@1:t=fill,` +
        `${draw},fade=t=in:d=0.4,settb=AVTB[intro];`
      );
    }
    case "C": {
      if (!stats) return buildA(); // 没数据没法当主角, 防御性兜 A
      // 数据大字当视觉主角: 超大 IF/分区(点缀色) + 小标签 + 分隔色条 + 标题小字 — 竖屏(1080x1920)为主设计
      const bigFs = fitFont(stats.bigText, Math.round(w * 0.86), Math.round(w / 4.5));
      const bigY = Math.round(h * 0.22);
      const smallFs = Math.round(w / 22);
      const smallY = bigY + Math.round(bigFs * 1.18);
      const barY = smallY + Math.round(smallFs * 2.2);
      const titleY = barY + Math.round(h * 0.05);
      const titleFs = Math.round(w / 20);
      return (
        `[1:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,` +
        `drawtext=fontfile='${font}':textfile='${stats.bigFile}':fontcolor=${accentColor}:fontsize=${bigFs}:x=(w-text_w)/2:y=${bigY},` +
        (stats.smallFile
          ? `drawtext=fontfile='${font}':textfile='${stats.smallFile}':fontcolor=white@0.72:fontsize=${smallFs}:x=(w-text_w)/2:y=${smallY},`
          : "") +
        `drawbox=x=${Math.round(w / 2 - w * 0.08)}:y=${barY}:w=${Math.round(w * 0.16)}:h=${Math.max(4, Math.round(h / 240))}:color=${accentColor}@1:t=fill,` +
        `drawtext=fontfile='${font}':textfile='${titleFile}':fontcolor=white@0.92:fontsize=${titleFs}:line_spacing=${Math.round(w / 80)}:x=(w-text_w)/2:y=${titleY},` +
        `fade=t=in:d=0.4,settb=AVTB[intro];`
      );
    }
    case "D": {
      // 大字报: 无图纯排版 — 超大标题左对齐拆行 + 下划线色条; 有分区文本时在标题上方加小字引导
      const x = Math.round(w * 0.08);
      const titleFs = Math.round(w / 10);
      const lineSp = Math.round(titleFs * 0.28);
      const titleY = Math.round(h * 0.3);
      // drawbox 没有 text_h 变量 → 用行数手算标题块高度定位色条(这就是 ctx 要 titleLines 的原因)
      const barY = titleY + titleLines * titleFs + (titleLines - 1) * lineSp + Math.round(h * 0.035);
      const kicker = stats?.smallFile
        ? `drawtext=fontfile='${font}':textfile='${stats.smallFile}':fontcolor=${accentColor}:fontsize=${Math.round(w / 24)}:x=${x}:y=${titleY - Math.round(h * 0.06)},`
        : "";
      return (
        `[1:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,` +
        kicker +
        `drawtext=fontfile='${font}':textfile='${titleFile}':fontcolor=white:fontsize=${titleFs}:line_spacing=${lineSp}:x=${x}:y=${titleY},` +
        `drawbox=x=${x}:y=${barY}:w=${Math.round(w * 0.28)}:h=${Math.max(8, Math.round(h / 140))}:color=${accentColor}@1:t=fill,` +
        `fade=t=in:d=0.4,settb=AVTB[intro];`
      );
    }
    default:
      return buildA();
  }
}
