/**
 * 7-02 混剪提质②: 字幕关键词强调 — SRT → 完整 ASS(数字/分区/硬词内联黄色加粗放大)。
 *
 * 为什么不用 force_style: force_style 只能整条字幕一个样式, 做不了"句中关键词单独高亮";
 *   ASS 内联覆盖标签 {\1c...\b1\fs..}...{\r} 可以精确到字符区间 → 这里把 SRT 解析后
 *   自己生成完整 ASS(Script Info + V4+ Styles + Dialogue), 烧录端换 ass= 滤镜。
 *
 * 为什么 PlayResY 固定 288: ffmpeg 的 subrip→ASS 默认头就是 384x288 坐标系,
 *   现有 env 里调好的字号 36 / MarginV 200 全是按这个坐标系肉眼校准的 —
 *   沿用同一坐标系(仅按视频宽高比修正 PlayResX), 保证视觉效果与老 force_style 路径一致。
 *
 * 纯函数、无 IO、无副作用 — 方便单测; 解析不出任何 cue 时返回 "", 由调用方降级老路径。
 */
import type { SubtitleAssStyle } from "./video-postprocess.js";

/**
 * 关键词命中规则(顺序即优先级, 正则交替从左到右尝试):
 *   1. 硬词全称在前(避免 "影响因子" 里的字被别的规则拆开);
 *   2. 分区([一二三四1-4]区 / Q1-4)在纯数字之前 — 否则 "2区" 的 "2" 会被数字规则单独吃掉;
 *   3. 拉丁词(SCI/IF/Q1)加 \b 词界, 防止命中 "LIFE"/"SCIENCE" 里的子串;
 *   4. 数字(含小数/百分号)垫底兜底。
 */
const EMPHASIS_RE = /影响因子|录用率|审稿周期|中科院|预警|\bSCI\b|\bIF\b|\bQ[1-4]\b|[一二三四1-4]\s*区|\d+(?:\.\d+)?%?/g;

interface SrtCue {
  startMs: number;
  endMs: number;
  text: string; // 多行 cue 用真实 \n 分隔; 输出 ASS 时才转 \N(避免被反斜杠转义误伤)
}

/** SRT 时间 "HH:MM:SS,mmm"(兼容 '.') → 毫秒; 非法返回 null。 */
function parseSrtTs(ts: string): number | null {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(ts.trim());
  if (!m) return null;
  return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]!.padEnd(3, "0"));
}

/** 毫秒 → ASS 时间 "H:MM:SS.cc"(厘秒)。 */
function fmtAssTs(ms: number): string {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p(min)}:${p(s)}.${p(cs)}`;
}

/**
 * ASS 文本转义: { } 是 ASS 覆盖标签定界符、\ 是标签前缀 — 都换成等宽全角字符,
 *   保持字符串长度不变(后面按 index 切片插标签, 长度变了会切错位)。
 */
function escAssText(s: string): string {
  return s.replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\\/g, "＼").replace(/\r/g, " ");
}

/** 输出前把真实换行转成 ASS 的 \N(此时文本里已不可能有裸反斜杠, 不会误伤)。 */
function toAssNewline(s: string): string {
  return s.replace(/\n/g, "\\N");
}

/** 解析 SRT 全文 → cue 数组。容忍多余空行/缺序号/多行文本。 */
export function parseSrt(srt: string): SrtCue[] {
  const cues: SrtCue[] = [];
  // 按空行分块; \r\n / \n 混排都容忍
  for (const block of srt.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const tlIdx = lines.findIndex((l) => l.includes("-->"));
    if (tlIdx < 0) continue;
    const [rawStart, rawEnd] = lines[tlIdx]!.split("-->");
    const startMs = parseSrtTs(rawStart ?? "");
    const endMs = parseSrtTs(rawEnd ?? "");
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = lines.slice(tlIdx + 1).filter(Boolean).join("\n");
    if (!text) continue;
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

/**
 * 强调区间的信息量权重(7-02 老韩反馈黄字可能过密, 每条限强调 maxEmphasis 处, 按权重挑):
 *   带小数/百分号的数值(IF 26.3 / 65%) > 分区(1区/Q1) > 纯数字 > 硬词。
 */
function spanWeight(s: string): number {
  if (/\d+\.\d+|%/.test(s)) return 3;
  if (/[一二三四1-4]\s*区|Q[1-4]/.test(s)) return 2;
  if (/\d/.test(s)) return 1.5;
  return 1;
}

/**
 * 单行文本 → 带内联强调标签的 ASS 文本。
 * 相邻命中(间隔为空或纯空白)合并成一个标签区间, 避免 "IF 3.5" 变成两段标签碎片。
 * @param maxEmphasis 每条字幕最多强调几处(按信息量权重挑, 位置早者优先); 0 = 不限
 */
export function emphasizeLine(text: string, baseFontSize: number, maxEmphasis = 0): string {
  const escaped = escAssText(text); // 逐字符等长替换, 不影响 match index
  EMPHASIS_RE.lastIndex = 0;
  let spans: Array<{ start: number; end: number; lastType: string }> = [];
  let m: RegExpExecArray | null;
  // hw=硬词(开启新语义单元) / num=数值·分区(附着在前一单元上)
  const tokenType = (s: string) => (/^(影响因子|录用率|审稿周期|中科院|预警|SCI|IF)$/.test(s) ? "hw" : "num");
  while ((m = EMPHASIS_RE.exec(escaped)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const last = spans[spans.length - 1];
    const curType = tokenType(m[0]);
    // 合并: 与上一命中相邻(间隔纯空白/空)则扩展上一区间 — 让 "影响因子26.3"/"IF 3.5" 成一个单元。
    // 7-02 例外: 上一单元已以数字/分区收尾、当前是硬词 → 断开(硬词开启新语义单元),
    //   否则 "影响因子26.3中科院1区录用率65%" 这类无空格连排会链式合并成整行黄字(满屏黄字最坏形态)。
    const gapOk = last && /^\s*$/.test(escaped.slice(last.end, start));
    if (gapOk && !(curType === "hw" && last!.lastType === "num")) {
      last!.end = end;
      last!.lastType = curType;
    } else {
      spans.push({ start, end, lastType: curType });
    }
    if (m[0].length === 0) EMPHASIS_RE.lastIndex++; // 防零宽死循环(理论不会)
  }
  if (spans.length === 0) return toAssNewline(escaped);
  // 超上限 → 按权重降序(同权重取位置靠前)挑 top-N, 再按位置排回去插标签
  if (maxEmphasis > 0 && spans.length > maxEmphasis) {
    spans = spans
      .map((s, i) => ({ ...s, w: spanWeight(escaped.slice(s.start, s.end)), i }))
      .sort((a, b) => b.w - a.w || a.i - b.i)
      .slice(0, maxEmphasis)
      .sort((a, b) => a.start - b.start);
  }
  // 黄色(&HBBGGRR&: 00FFFF=黄) + 加粗 + 放大 1.35 倍; {\r} 重置回 Default 样式
  const emFs = Math.round(baseFontSize * 1.35);
  const openTag = `{\\1c&H00FFFF&\\b1\\fs${emFs}}`;
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += escaped.slice(cursor, s.start) + openTag + escaped.slice(s.start, s.end) + "{\\r}";
    cursor = s.end;
  }
  return toAssNewline(out + escaped.slice(cursor));
}

/**
 * 中文强制换行保底(7-02): ffmpeg 4.4 的 libass(0.15) 不会给无空格的 CJK 自动换行,
 *   超宽行会直接溢出画面两侧(老韩截图实锤) — 所以超过 maxCharsPerLine 的行必须手动断。
 *   断点优先挑中点附近(±3)的标点/空格, 挑不到就硬切中点; 过长行递归多切。
 */
export function wrapCjkLine(line: string, maxCharsPerLine: number): string[] {
  if (line.length <= maxCharsPerLine) return [line];
  const mid = Math.ceil(line.length / 2);
  let cut = -1;
  let dropPunct = false; // 7-02: 在标点处断则该标点不带入任一行(否则上行行尾挂个逗号很丑)
  for (let d = 0; d <= 3; d++) {
    for (const idx of [mid + d, mid - d]) {
      if (idx > 0 && idx < line.length && /[，、,;；\s]/.test(line[idx - 1]!)) { cut = idx; dropPunct = true; break; }
    }
    if (cut > 0) break;
  }
  if (cut <= 0) cut = mid; // 无标点: 硬切中点, 不丢字
  const first = dropPunct ? line.slice(0, cut - 1) : line.slice(0, cut); // 标点断: 上行去掉行尾标点
  return [...wrapCjkLine(first.trim(), maxCharsPerLine), ...wrapCjkLine(line.slice(cut).trim(), maxCharsPerLine)].filter(Boolean);
}

/** "&H00FFFFFF&" / "&H00FFFFFF" → ASS Styles 行标准形 "&H00FFFFFF"; 非法回退给定默认。 */
function normColour(c: string | undefined, fallback: string): string {
  const t = (c ?? "").trim().replace(/&$/, "");
  return /^&H[0-9A-Fa-f]{6,8}$/.test(t) ? t : fallback;
}

/**
 * 主入口: SRT 全文 → 完整 ASS 文本(含关键词强调)。
 * @param style   现有字幕样式(与 force_style 同一套字段, 视觉参数不变)
 * @param videoW/videoH 视频像素尺寸 — 只用来算 PlayResX 宽高比, 字号坐标系仍锚定 PlayResY=288
 * @returns ASS 全文; 解析不出 cue 时返回 ""(调用方据此降级老路径)
 */
export function srtToAssWithEmphasis(
  srt: string,
  style: Required<SubtitleAssStyle>,
  videoW: number,
  videoH: number,
  opts?: { maxEmphasis?: number; maxCharsPerLine?: number },
): string {
  const cues = parseSrt(srt);
  if (cues.length === 0) return "";

  const playResY = 288;
  const playResX = videoW > 0 && videoH > 0 ? Math.max(1, Math.round((playResY * videoW) / videoH)) : 384;
  const marginLR = 8; // 7-02: 原 30 在 PlayResX≈162 竖屏坐标系里 = 两侧各占 18% 屏宽, 挤没了文本区; 8≈5%
  // 每行最大字数: 可用宽度(PlayResX - 两侧边距)按字号折算, 1.1 = CJK 实测字advance略小于字号的余量
  const maxChars = opts?.maxCharsPerLine
    ?? Math.max(6, Math.floor(((playResX - marginLR * 2) * 1.1) / Math.max(1, style.fontSize)));
  const maxEmphasis = opts?.maxEmphasis ?? 0;
  const primary = normColour(style.primaryColour, "&H00FFFFFF");
  const outline = normColour(style.outlineColour, "&H00000000");
  // ASS Styles 的 Bold 用 -1 表示 true(不是 1)
  const bold = style.bold ? -1 : 0;

  const header = [
    "[Script Info]",
    "; Generated by subtitle-emphasis (BossMate 混剪提质②)",
    "ScriptType: v4.00+",
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${style.fontName},${style.fontSize},${primary},&H000000FF,${outline},&H00000000,${bold},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},${style.alignment},${marginLR},${marginLR},${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = cues
    .map((c) => {
      // 先强制换行(每个已有行独立判断), 再做强调 — 换行插的是真实\n, emphasizeLine 输出时统一转 \N
      const wrapped = c.text.split("\n").flatMap((l) => wrapCjkLine(l, maxChars)).join("\n");
      return `Dialogue: 0,${fmtAssTs(c.startMs)},${fmtAssTs(c.endMs)},Default,,0,0,0,,${emphasizeLine(wrapped, style.fontSize, maxEmphasis)}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}
