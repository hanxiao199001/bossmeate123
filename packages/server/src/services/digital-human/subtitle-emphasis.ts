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
 * 单行文本 → 带内联强调标签的 ASS 文本。
 * 相邻命中(间隔为空或纯空白)合并成一个标签区间, 避免 "IF 3.5" 变成两段标签碎片。
 */
export function emphasizeLine(text: string, baseFontSize: number): string {
  const escaped = escAssText(text); // 逐字符等长替换, 不影响 match index
  EMPHASIS_RE.lastIndex = 0;
  const spans: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = EMPHASIS_RE.exec(escaped)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const last = spans[spans.length - 1];
    // 合并: 与上一命中相邻(间隔纯空白)则扩展上一区间
    if (last && /^\s*$/.test(escaped.slice(last.end, start))) last.end = end;
    else spans.push({ start, end });
    if (m[0].length === 0) EMPHASIS_RE.lastIndex++; // 防零宽死循环(理论不会)
  }
  if (spans.length === 0) return toAssNewline(escaped);
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
): string {
  const cues = parseSrt(srt);
  if (cues.length === 0) return "";

  const playResY = 288;
  const playResX = videoW > 0 && videoH > 0 ? Math.max(1, Math.round((playResY * videoW) / videoH)) : 384;
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
    `Style: Default,${style.fontName},${style.fontSize},${primary},&H000000FF,${outline},&H00000000,${bold},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},${style.alignment},30,30,${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = cues
    .map((c) => `Dialogue: 0,${fmtAssTs(c.startMs)},${fmtAssTs(c.endMs)},Default,,0,0,0,,${emphasizeLine(c.text, style.fontSize)}`)
    .join("\n");

  return `${header}\n${events}\n`;
}
