/**
 * 6-26 音频驱动数字人专用: 自己用口播稿文字 + 音频总时长生成 SRT。
 *   背景: submitAudioTo2D(音频驱动)DVH 不知道文字 → 不返回字幕 SRT(VideoInfo 无字幕字段),
 *   而短视频必须有字幕。我们手里有口播稿全文 + 视频/音频总时长, 按字数比例切句分时即可。
 *   时间轴非逐字精确(无 word-level 对齐), 但按字数比例分配, 对 1 分钟口播足够贴。
 */

/** 把一段口播稿切成字幕 cue: 先按句末标点断句, 过长再按 ~16 字硬切。 */
function splitCues(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  const cues: string[] = [];
  const MAX = 16;
  for (const s of sentences) {
    // 去掉句尾标点占位(字幕里不显示标点更干净), 但保留逗号断句
    if (s.length <= MAX + 2) {
      cues.push(s);
    } else {
      // 优先按逗号/顿号切, 再按长度硬切
      const sub = s.split(/(?<=[，、,])/).map((x) => x.trim()).filter(Boolean);
      for (const piece of sub) {
        if (piece.length <= MAX + 2) cues.push(piece);
        else for (let i = 0; i < piece.length; i += MAX) cues.push(piece.slice(i, i + MAX));
      }
    }
  }
  return cues.map((c) => c.replace(/[。！？!?；;，、,]+$/g, "")).filter(Boolean);
}

function fmtTs(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(z, 3)}`;
}

/**
 * 口播稿 + 总时长(ms) → SRT 文本。按各 cue 字数比例分配时长。
 * @param totalMs 视频/音频总时长(优先用 DVH 返回的视频时长)
 */
export function buildSrtFromText(text: string, totalMs: number): string {
  const cues = splitCues(text);
  if (cues.length === 0 || !(totalMs > 0)) return "";
  const totalChars = cues.reduce((sum, c) => sum + Math.max(1, c.length), 0);
  let t = 0;
  let out = "";
  cues.forEach((c, i) => {
    const share = Math.max(1, c.length) / totalChars;
    let dur = Math.round(totalMs * share);
    dur = Math.max(700, Math.min(6000, dur)); // 单条 0.7~6s 兜底
    const start = t;
    let end = t + dur;
    if (i === cues.length - 1) end = Math.max(end, totalMs); // 最后一条铺到结尾
    out += `${i + 1}\n${fmtTs(start)} --> ${fmtTs(end)}\n${c}\n\n`;
    t = end;
  });
  return out;
}
